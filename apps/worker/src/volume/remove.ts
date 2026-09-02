import { setTimeout as sleep } from "node:timers/promises";

import { execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

const VOLUME_ALREADY_GONE = /not found|no such volume/i;

const ATTEMPTS = 20;
const RETRY_MS = 1000;

export function databaseVolumeNames(database: {
  extraMounts: { source: string; type: string }[];
  swarmName: string;
}): string[] {
  return [
    database.swarmName,
    ...database.extraMounts
      .filter((mount) => mount.type === "volume")
      .map((mount) => mount.source),
  ];
}

export async function removeVolumes(
  client: SshClient,
  volumeNames: string[],
  stuckMessage: (volumeName: string) => string
): Promise<void> {
  for (const volumeName of volumeNames) {
    let volumeGone = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const res = await execArgv(client, [
        "sudo",
        "docker",
        "volume",
        "rm",
        volumeName,
      ]);
      if (res.code === 0 || VOLUME_ALREADY_GONE.test(res.stderr)) {
        volumeGone = true;
        break;
      }
      await sleep(RETRY_MS);
    }
    if (!volumeGone) {
      throw new Error(stuckMessage(volumeName));
    }
  }
}
