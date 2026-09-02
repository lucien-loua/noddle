import { execStream, quoteArg } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} is not a safe identifier: "${value}". Use letters, digits and underscores only, not starting with a digit`
    );
  }
}

export function legacyDatabaseServiceName(name: string): string {
  return `noddle-db-${name}`;
}

export async function findDatabaseContainer(
  client: SshClient,
  serviceName: string
): Promise<string> {
  const { code, stderr, value } = await execStream(
    client,
    `docker ps --no-trunc --filter ${quoteArg(`label=com.docker.swarm.service.name=${serviceName}`)} --format ${quoteArg("{{.ID}}")}`,
    async ({ stdout }) => {
      let out = "";
      stdout.setEncoding("utf-8");
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
      `no running container for ${serviceName}. Is the database up?`
    );
  }
  return id;
}
