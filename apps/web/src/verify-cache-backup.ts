// tier: pure
// bun run apps/web/src/verify-cache-backup.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const DELETE_BACKUP_RUN = /deleteBackupRun[\s\S]*?cache\.backupRunsFor/;
const TRIGGER_BACKUP_RUN = /triggerBackupRun[\s\S]*?cache\.backupRunsFor/;
const ROOT = join(import.meta.dirname, "components/features");

const PANEL = "backups/panel.tsx";
const HISTORY = "backups/history.tsx";
const CONFIG_CARD = "backups/config-card.tsx";

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

  const panel = readFeature(PANEL);
  check(
    `${PANEL} invalidates via backupConfigsFor`,
    panel.includes("backupConfigsFor(")
  );
  check(
    `${PANEL} queries via backupConfigsFor(subject)`,
    panel.includes("queries.backupConfigsFor(subject)")
  );
  const panelLegacy = lacksLegacy(panel, LEGACY_CACHE);
  check(
    `${PANEL} avoids legacy cache helpers`,
    panelLegacy.length === 0,
    panelLegacy.join(", ")
  );

  const history = readFeature(HISTORY);
  check(
    `${HISTORY} uses deleteBackupRun`,
    history.includes("deleteBackupRun(")
  );
  check(
    `${HISTORY} queries via backupRunsFor(subject)`,
    history.includes("queries.backupRunsFor(subject")
  );
  const historyLegacy = lacksLegacy(history, LEGACY_MUTATIONS);
  check(
    `${HISTORY} avoids legacy mutations`,
    historyLegacy.length === 0,
    historyLegacy.join(", ")
  );

  const card = readFeature(CONFIG_CARD);
  check(
    `${CONFIG_CARD} uses triggerBackupRun`,
    card.includes("triggerBackupRun(")
  );
  const cardLegacy = lacksLegacy(card, [...LEGACY_CACHE, ...LEGACY_MUTATIONS]);
  check(
    `${CONFIG_CARD} avoids legacy trigger/cache`,
    cardLegacy.length === 0,
    cardLegacy.join(", ")
  );
});
