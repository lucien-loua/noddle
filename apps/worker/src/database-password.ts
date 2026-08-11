import { secretPathFor } from "@noddle/database-spec";
import { databases } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import type { DatabaseEngine } from "@noddle/shared/database-engines";
import {
  type DockerApi,
  disconnect,
  dockerClient,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { assertSafeIdentifier, findDatabaseContainer } from "#backup";
import { connectForDeploy, type DeployContext } from "#runtime-context";

/**
 * Runs a `sh` script INSIDE the container, feeding it `input` on standard
 * input.
 *
 * Shaped as a CONSUMER, like `execStream`: the streams aren't handed back
 * to the caller, who could forget to wait for the exit code. And that code
 * is the only thing that tells "the password changed" apart from "the
 * client printed an error".
 */
async function runInContainer(
  client: SshClient,
  opts: { containerId: string; input: string; script: string }
): Promise<void> {
  const argv = [
    "docker",
    "exec",
    "-i",
    opts.containerId,
    "sh",
    "-c",
    opts.script,
  ];
  const { code, stderr } = await execStream(
    client,
    argv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      // Drained: without a reader, the channel's window fills up and the
      // remote process blocks on write. Same pitfall as restores.
      stdout.resume();
      await new Promise<void>((resolve, reject) => {
        stdin.on("error", reject);
        stdin.end(opts.input, () => resolve());
      });
    }
  );
  if (code !== 0) {
    throw new Error(
      `password change failed (exit ${code}): ${stderr.slice(0, 500)}`
    );
  }
}

/**
 * Escapes a SQL string literal for MySQL/MariaDB.
 *
 * Both the apostrophe AND the backslash: unlike standard SQL, MySQL treats
 * the backslash as an escape character by default, so only doubling
 * apostrophes would let `\'` through.
 */
function mysqlLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "''");
}

/** Escapes a value for psql's `\set` metacommand. */
function psqlSetLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/** The `sh` script run inside the container — never the NEW password. */
function alterScript(engine: DatabaseEngine, rootUser: string): string {
  const secret = secretPathFor(engine);

  switch (engine) {
    case "postgres":
      // No password: in the official container, the generated `pg_hba`
      // sets LOCAL socket connections to `trust` — the same fact `pg_dump`
      // already relies on for backups.
      //
      // `ON_ERROR_STOP=1` isn't decorative: without it psql returns 0
      // after a rejected ALTER, so the password would get saved to the
      // database without having changed anywhere. This is the very shape
      // of "a failed deploy exits 0".
      return `exec psql -v ON_ERROR_STOP=1 -U ${quoteArg(rootUser)} -d postgres`;

    case "mariadb":
    case "mysql": {
      const binary = engine === "mariadb" ? "mariadb" : "mysql";
      // The CURRENT password comes from the mounted secret, through a
      // config file written with `umask 077` — never `-p<password>` or
      // `MYSQL_PWD`, which would put it in the argv or in
      // `/proc/<pid>/environ`. Same technique as the healthcheck right
      // next to it.
      return `umask 077 && { printf '[client]\\npassword='; cat ${secret}; printf '\\n'; } > /tmp/np.cnf && ${binary} --defaults-extra-file=/tmp/np.cnf --user=root; rc=$?; rm -f /tmp/np.cnf; exit $rc`;
    }

    case "mongo":
      // The JS script arrives on standard input and is written to a file:
      // `--eval` would put it in the argv, new password included.
      return `umask 077 && cat > /tmp/np.js && NODDLE_CUR="$(cat ${secret})" mongosh --quiet --nodb --file /tmp/np.js; rc=$?; rm -f /tmp/np.js; exit $rc`;

    default:
      // `-x` reads the LAST argument from standard input: the new
      // password therefore never appears in redis-cli's argv. `CONFIG SET`
      // takes effect immediately; it's the secret rotation right after
      // that makes it durable — the config file is regenerated on every
      // restart.
      return `REDISCLI_AUTH="$(cat ${secret})" exec redis-cli -x CONFIG SET requirepass`;
  }
}

/** What goes out on STANDARD INPUT: the only channel that isn't observable. */
function alterInput(
  engine: DatabaseEngine,
  rootUser: string,
  password: string
): string {
  switch (engine) {
    case "postgres":
      // `\set` then `:'pw'`: psql itself quotes the value, so there's no
      // apostrophe to stitch back together by hand in the final SQL.
      return `\\set pw '${psqlSetLiteral(password)}'\nALTER USER "${rootUser}" WITH PASSWORD :'pw';\n`;

    case "mariadb":
    case "mysql": {
      // THREE accounts, each with `IF EXISTS` — the official image creates
      // `root@localhost` IN ADDITION TO `root@%`, verified in `mysql.user`.
      //
      // This is NOT for the healthcheck: verified by removing
      // `root@localhost` from this list, the database survives a forced
      // restart. A connection over 127.0.0.1 from the container matches
      // `root@%` — the rejection message says `'root'@'127.0.0.1'`, so no
      // reverse resolver ever maps it back to `localhost`.
      //
      // The real reason is simpler: a password change that leaves an
      // account behind isn't a password change. The old one would still
      // open the database through the local socket, with full privileges,
      // under a value the user believes was removed.
      //
      // `IF EXISTS` because the list depends on the image, and an `ALTER
      // USER` on a missing account is a fatal error.
      const literal = mysqlLiteral(password);
      const accounts = [
        `'${mysqlLiteral(rootUser)}'@'%'`,
        "'root'@'%'",
        "'root'@'localhost'",
      ];
      return `${accounts
        .map(
          (account) =>
            `ALTER USER IF EXISTS ${account} IDENTIFIED BY '${literal}';`
        )
        .join("\n")}\nFLUSH PRIVILEGES;\n`;
    }

    case "mongo":
      // `JSON.stringify` for both values: mongosh is a real JS runtime, so
      // that's the right kind of escaping. The CURRENT password, for its
      // part, stays in the environment of the one process that needs it.
      return [
        'const conn = Mongo("mongodb://127.0.0.1:27017/admin");',
        'const admin = conn.getDB("admin");',
        `if (!admin.auth(${JSON.stringify(rootUser)}, process.env.NODDLE_CUR)) {`,
        '  throw new Error("authentication with the current password failed");',
        "}",
        `admin.changeUserPassword(${JSON.stringify(rootUser)}, ${JSON.stringify(password)});`,
        "",
      ].join("\n");

    default:
      // With NO trailing newline: `-x` takes standard input as-is.
      return password;
  }
}

/**
 * Rotates the Swarm secret and updates the service to mount it.
 *
 * A secret is IMMUTABLE: the new one's name therefore carries a suffix,
 * while the name of the MOUNTED FILE stays the same — that's what the
 * container's commands know, and it's written into the healthcheck as well
 * as the startup command.
 */
async function rotateSecret(
  managerDocker: DockerApi,
  opts: { password: string; serviceName: string }
): Promise<void> {
  const { password, serviceName } = opts;

  const services = await managerDocker.listServices({
    filters: JSON.stringify({ name: [serviceName] }),
  });
  const service = services.find((s) => s.Spec?.Name === serviceName);
  if (!service) {
    throw new Error(`Swarm service not found: ${serviceName}`);
  }

  const spec = service.Spec as Record<string, unknown>;
  const container = (spec.TaskTemplate as Record<string, unknown> | undefined)
    ?.ContainerSpec as
    | { Secrets?: Array<{ File?: { Name?: string }; SecretName?: string }> }
    | undefined;
  const mount = container?.Secrets?.[0];
  if (!mount?.File?.Name) {
    throw new Error(`no secret mounted on ${serviceName}`);
  }

  const previousName = mount.SecretName;
  // ONE name computed once, reused for both creation AND the spec: deriving
  // them separately from `Date.now()` would give two different timestamps,
  // hence a spec pointing at a secret that doesn't exist.
  const nextName = `${serviceName}-password-${Date.now()}`;
  const created = (await managerDocker.createSecret({
    Data: Buffer.from(password, "utf8").toString("base64"),
    Name: nextName,
  })) as unknown as { ID?: string; id?: string };

  await managerDocker.getService(service.ID as string).update({
    ...spec,
    TaskTemplate: {
      ...(spec.TaskTemplate as Record<string, unknown>),
      ContainerSpec: {
        ...container,
        Secrets: [
          {
            ...mount,
            SecretID: created.ID ?? created.id,
            SecretName: nextName,
          },
        ],
      },
    },
    version: service.Version?.Index,
  });

  if (previousName) {
    try {
      const olds = (await managerDocker.listSecrets({
        filters: JSON.stringify({ name: [previousName] }),
      })) as unknown as Array<{ ID?: string; Spec?: { Name?: string } }>;
      const old = olds.find((x) => x.Spec?.Name === previousName);
      if (old?.ID) {
        await managerDocker.getSecret(old.ID).remove();
      }
    } catch {
      // Best-effort, like during teardown: an orphaned secret is a
      // low-cost cleanup debt, never lost data, and it must not fail a
      // password change that itself succeeded.
    }
  }
}

export async function changeDatabasePassword(
  ctx: DeployContext,
  databaseId: string,
  password: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${databaseId}`);
  }

  const rootUser = database.rootUser ?? "root";
  assertSafeIdentifier(rootUser, "database user");

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    database.server
  );

  try {
    const containerId = await findDatabaseContainer(
      buildClient,
      database.swarmName
    );

    await runInContainer(buildClient, {
      containerId,
      input: alterInput(database.engine, rootUser, password),
      script: alterScript(database.engine, rootUser),
    });

    const managerDocker = sameConnection
      ? dockerClient(buildClient)
      : dockerClient(managerClient);
    await rotateSecret(managerDocker, {
      password,
      serviceName: database.swarmName,
    });

    await ctx.db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          password,
          ctx.appKey,
          secretContext.databasePassword(database.id)
        ),
      })
      .where(eq(databases.id, database.id));
  } finally {
    if (managerClient !== buildClient) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
