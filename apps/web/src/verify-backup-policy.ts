// tier: pure
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify, suite } from "@noddle/testing";

import { assertRestorableRun, toBackupRunRow } from "./server/backups/policy";
import type { BackupRunRow } from "./server/backups/policy";

const BACKUPS = join(import.meta.dirname, "server/backups");

const SURFACES = [
  "configs.ts",
  "runs.ts",
  "volume/configs.ts",
  "volume/runs.ts",
] as const;

function read(file: string): string {
  return readFileSync(join(BACKUPS, file), "utf-8");
}

const SHARED_RULES = [
  ["S3 destination not found", "the destination guard", "shared.ts"],
  ["still in progress", "the in-flight delete guard", "shared.ts"],
  ["deleteObject(", "the tolerated object delete", "shared.ts"],
  ["can be restored", "the restorable check", "policy.ts"],
] as const;

const COMPLETED: BackupRunRow["status"] = "completed";

function run(status: BackupRunRow["status"]) {
  return { status };
}

await runVerify("backup policy", async () => {
  await suite("each rule is written exactly once", () => {
    for (const [needle, what, home] of SHARED_RULES) {
      const owners = SURFACES.filter((file) => read(file).includes(needle));
      check(
        `no server function re-states ${what}`,
        owners.length === 0,
        owners.join(", ")
      );
      check(`${what} lives in ${home}`, read(home).includes(needle));
    }
  });

  await suite("both run listings map through one mapper", () => {
    for (const file of ["runs.ts", "volume/runs.ts"] as const) {
      const src = read(file);
      check(`${file} uses toBackupRunRow`, src.includes("toBackupRunRow"));
      check(
        `${file} does not re-map the run shape by hand`,
        !src.includes("createdAt: b.createdAt.toISOString()")
      );
    }
  });

  await suite("the mapper turns dates into ISO strings", () => {
    const mapped = toBackupRunRow({
      configId: null,
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      errorMessage: null,
      finishedAt: null,
      id: "run-1",
      kind: "manual",
      objectKey: "k",
      sizeBytes: 12,
      status: COMPLETED,
    });
    check("createdAt is ISO", mapped.createdAt === "2026-01-02T03:04:05.000Z");
    check("a null finishedAt stays null", mapped.finishedAt === null);
  });

  await suite("a run is restorable only if it is yours and it finished", () => {
    let refusedMissing = false;
    try {
      assertRestorableRun(undefined, true, {
        noun: "backup",
        owner: "database",
      });
    } catch (error) {
      refusedMissing = (error as Error).message.includes(
        "backup not found for this database"
      );
    }
    check("a missing run is refused, by name", refusedMissing);

    let refusedForeign = false;
    try {
      assertRestorableRun(run(COMPLETED), false, {
        noun: "volume backup",
        owner: "service",
      });
    } catch (error) {
      refusedForeign = (error as Error).message.includes(
        "volume backup not found for this service"
      );
    }
    check("another resource's run is refused", refusedForeign);

    let refusedUnfinished = false;
    try {
      assertRestorableRun(run("running"), true, {
        noun: "backup",
        owner: "database",
      });
    } catch (error) {
      refusedUnfinished = (error as Error).message.includes("only a completed");
    }
    check("an unfinished run is refused", refusedUnfinished);

    let accepted = true;
    try {
      assertRestorableRun(run(COMPLETED), true, {
        noun: "backup",
        owner: "database",
      });
    } catch {
      accepted = false;
    }
    check("a completed run that belongs here is accepted", accepted);
  });
});
