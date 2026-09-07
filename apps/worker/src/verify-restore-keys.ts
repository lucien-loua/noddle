// tier: pure
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, runVerify, suite } from "@noddle/testing";

import {
  assertArchiveKeysScript,
  mergeArchiveKeysScript,
  restoreScript,
} from "./control-plane-backup.ts";

const dir = mkdtempSync(join(tmpdir(), "noddle-restore-keys-"));
const archive = join(dir, "archive-env");

function guardAccepts(envBody: string): boolean {
  writeFileSync(archive, envBody);
  try {
    execFileSync("sh", ["-c", `set -e; ${assertArchiveKeysScript(archive)}`], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

const ONE_OF_EACH = "APP_KEY=abc=\nREGISTRY_PASSWORD=xyz\n";
const script = restoreScript("PG_RESTORE_HERE");
const at = (needle: string) => script.indexOf(needle);

await runVerify("control-plane restore key handling", async () => {
  await suite(
    "the archive env is validated before anything destructive",
    () => {
      check(
        "the guard runs before pg_restore",
        at("expected exactly 1") < at("PG_RESTORE_HERE")
      );
      check(
        "the guard runs before /etc/noddle is replaced",
        at("expected exactly 1") < at("rm -rf /etc/noddle")
      );
      check(
        "the merge runs after the restore",
        at("PG_RESTORE_HERE") < at("sed -i")
      );
    }
  );

  await suite("the guard counts lines instead of trusting grep", () => {
    check("exactly one of each is accepted", guardAccepts(ONE_OF_EACH));
    check(
      "a missing APP_KEY is refused",
      !guardAccepts("REGISTRY_PASSWORD=xyz\n")
    );
    check(
      "a missing REGISTRY_PASSWORD is refused",
      !guardAccepts("APP_KEY=abc=\n")
    );
    check(
      "a duplicated APP_KEY is refused",
      !guardAccepts(`APP_KEY=one\n${ONE_OF_EACH}`)
    );
    check("an empty archive env is refused", !guardAccepts(""));
  });

  await suite("the merge takes the archive's keys and only those", () => {
    const merge = mergeArchiveKeysScript("$d/env", "/etc/x/.env");
    check("APP_KEY is taken", merge.includes("APP_KEY"));
    check("REGISTRY_PASSWORD is taken", merge.includes("REGISTRY_PASSWORD"));
    check(
      "POSTGRES_PASSWORD is never touched",
      !merge.includes("POSTGRES_PASSWORD")
    );
    check("REDIS_PASSWORD is never touched", !merge.includes("REDIS_PASSWORD"));
    check(
      "the value keeps everything after the first =",
      merge.includes("cut -d= -f2-")
    );
    check(
      "the old line is removed before the new one is appended",
      merge.indexOf("sed -i") < merge.indexOf(">>")
    );
  });
});

rmSync(dir, { force: true, recursive: true });
