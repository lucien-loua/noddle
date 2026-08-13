import {
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Rejects identifiers that would break shell / SQL stitching in dump, restore,
 * and password-change scripts. Letters, digits, underscore; no leading digit.
 */
export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} is not a safe identifier: "${value}" — letters, digits and underscores only, not starting with a digit`
    );
  }
}

/** Legacy Swarm service name before `swarmName` lived on the row. */
export function legacyDatabaseServiceName(name: string): string {
  return `noddle-db-${name}`;
}

/**
 * Running task container for a Swarm database service.
 *
 * Shared by dump, restore, and password rotation — none of which belong in
 * `#backup-run` alone.
 */
export async function findDatabaseContainer(
  client: SshClient,
  serviceName: string
): Promise<string> {
  const { code, stderr, value } = await execStream(
    client,
    `docker ps --no-trunc --filter ${quoteArg(`label=com.docker.swarm.service.name=${serviceName}`)} --format ${quoteArg("{{.ID}}")}`,
    async ({ stdout }) => {
      let out = "";
      stdout.setEncoding("utf8");
      for await (const chunk of stdout) {
        out += chunk as string;
      }
      return out;
    }
  );
  if (code !== 0) {
    throw new Error(`docker ps failed (code ${code}): ${stderr}`);
  }
  const id = value
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!id) {
    throw new Error(
      `no running container for ${serviceName} — is the database up?`
    );
  }
  return id;
}
