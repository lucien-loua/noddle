// bun run apps/web/src/verify-cache-backup.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, runVerify } from "@noddle/shared/verify-harness";

const DELETE_BACKUP_RUN = /deleteBackupRun[\s\S]*?cache\.backupRunsFor/;
const TRIGGER_BACKUP_RUN = /triggerBackupRun[\s\S]*?cache\.backupRunsFor/;
const ROOT = join(import.meta.dirname, "components/features");

const PANELS = ["backups/panel.tsx", "volume-backups/panel.tsx"] as const;

const HISTORY = [
  "backups/backup-history.tsx",
  "volume-backups/history.tsx",
] as const;

const CONFIG_CARDS = [
  "backups/backup-config-card.tsx",
  "volume-backups/config-card.tsx",
] as const;

const LEGACY_CACHE = [
  "cache.backupConfigs(",
  "cache.volumeBackupConfigs(",
  "cache.backups(",
  "cache.volumeBackups(",
] as const;

const LEGACY_MUTATIONS = [
  "mutations.deleteBackup(",
  "mutations.deleteVolumeBackup(",
  "mutations.triggerBackup(",
  "mutations.triggerVolumeBackup(",
] as const;

function readFeature(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function lacksLegacy(source: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => source.includes(needle));
}

await runVerify("backup cache seam (C8)", () => {
  const mutations = readFileSync(
    join(import.meta.dirname, "lib/mutations.ts"),
    "utf8"
  );
  const cache = readFileSync(join(import.meta.dirname, "lib/cache.ts"), "utf8");

  check(
    "deleteBackupRun invalidates via cache.backupRunsFor",
    DELETE_BACKUP_RUN.test(mutations)
  );
  check(
    "triggerBackupRun invalidates via cache.backupRunsFor",
    TRIGGER_BACKUP_RUN.test(mutations)
  );
  check(
    "legacy cache helpers delegate to *For",
    cache.includes("cache.backupConfigsFor(qc, databaseBackupSubject") &&
      cache.includes("cache.backupRunsFor(qc, databaseBackupSubject")
  );

  for (const file of PANELS) {
    const src = readFeature(file);
    check(
      `${file} invalidates via backupConfigsFor`,
      src.includes("backupConfigsFor(")
    );
    check(
      `${file} uses a backup subject helper`,
      src.includes("databaseBackupSubject(") ||
        src.includes("volumeBackupSubject(")
    );
    const legacy = lacksLegacy(src, LEGACY_CACHE);
    check(
      `${file} avoids legacy cache helpers`,
      legacy.length === 0,
      legacy.join(", ")
    );
  }

  for (const file of HISTORY) {
    const src = readFeature(file);
    check(`${file} uses deleteBackupRun`, src.includes("deleteBackupRun("));
    check(
      `${file} uses a backup subject helper`,
      src.includes("databaseBackupSubject(") ||
        src.includes("volumeBackupSubject(")
    );
    const legacy = lacksLegacy(src, LEGACY_MUTATIONS);
    check(
      `${file} avoids legacy mutations`,
      legacy.length === 0,
      legacy.join(", ")
    );
  }

  for (const file of CONFIG_CARDS) {
    const src = readFeature(file);
    check(`${file} uses triggerBackupRun`, src.includes("triggerBackupRun("));
    check(
      `${file} uses a backup subject helper`,
      src.includes("databaseBackupSubject(") ||
        src.includes("volumeBackupSubject(")
    );
    const legacy = lacksLegacy(src, [...LEGACY_CACHE, ...LEGACY_MUTATIONS]);
    check(
      `${file} avoids legacy trigger/cache`,
      legacy.length === 0,
      legacy.join(", ")
    );
  }
});
