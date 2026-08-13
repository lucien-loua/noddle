import { encryptSecret, secretContext } from "@noddle/crypto";
import { passwordChangeFor } from "@noddle/database-spec";
import { databases } from "@noddle/db/schema";
import {
  type DockerApi,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { assertSafeIdentifier, findDatabaseContainer } from "#database-runtime";
import { withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";

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

  await withDeployClients(
    ctx,
    database.server,
    async ({ buildClient, managerDocker }) => {
      const containerId = await findDatabaseContainer(
        buildClient,
        database.swarmName
      );

      const change = passwordChangeFor(database.engine, {
        password,
        rootUser,
      });
      await runInContainer(buildClient, {
        containerId,
        input: change.input,
        script: change.script,
      });

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
    }
  );
}
