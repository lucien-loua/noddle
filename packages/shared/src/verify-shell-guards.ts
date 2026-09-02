// tier: pure
import { readFileSync } from "node:fs";

import { check, runVerify } from "@noddle/testing";

const SCRIPTS = [
  "scripts/spike-local.sh",
  "scripts/adopt-local.sh",
  "installer/install.sh",
];

const ROOT = new URL("../../../", import.meta.url).pathname;
const STRICT = /^set -euo pipefail$/m;
const SILENCED_SUBSTITUTION =
  /\$\((?:[^()]|\([^()]*\))*2>\/dev\/null(?:[^()]|\([^()]*\))*\)/g;
const NEUTRALIZED = /\|\|\s*(true|echo\b|:)/;
const GREP_Q = /\|\s*grep\s+-[a-zA-Z]*q/;
const COMMENT_LINE = /^\s*#/;

await runVerify("shell guards (pipefail traps)", () => {
  for (const script of SCRIPTS) {
    const file = readFileSync(ROOT + script, "utf-8");
    const source = file
      .split("\n")
      .filter((line) => !COMMENT_LINE.test(line))
      .join("\n");

    check(`${script} runs under set -euo pipefail`, STRICT.test(source));

    check(
      `${script} never pipes into grep -q`,
      !GREP_Q.test(source),
      "the producer takes SIGPIPE and pipefail fails the pipeline — query state directly"
    );

    const unguarded = (source.match(SILENCED_SUBSTITUTION) ?? []).filter(
      (substitution) => !NEUTRALIZED.test(substitution)
    );
    check(
      `${script} neutralizes every substitution that silences stderr`,
      unguarded.length === 0,
      unguarded.join("\n")
    );
  }
});
