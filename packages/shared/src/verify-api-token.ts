// tier: pure
import { readFileSync } from "node:fs";

import { check, runVerify, suite } from "@noddle/testing";

import {
  CHECKSUM_LENGTH,
  DISPLAY_PREFIX_LENGTH,
  generateToken,
  isWellFormedToken,
  SECRET_LENGTH,
  TOKEN_PREFIX,
} from "#api-token";

const SAMPLE = 2000;
const minted = Array.from({ length: SAMPLE }, () => generateToken());
const one = minted[0] as string;
const SOURCE = new URL("api-token.ts", import.meta.url).pathname;

await runVerify("api token format", async () => {
  await suite("the shape a secret scanner matches on", () => {
    check(
      "every token carries the prefix",
      minted.every((t) => t.startsWith(TOKEN_PREFIX))
    );
    check(
      "length is fixed, so truncation is visible",
      new Set(minted.map((t) => t.length)).size === 1
    );
    check(
      "the display prefix keeps four characters of secret",
      one.slice(0, DISPLAY_PREFIX_LENGTH).length === TOKEN_PREFIX.length + 4
    );
  });

  await suite("entropy", () => {
    check("every token drawn is distinct", new Set(minted).size === SAMPLE);
    check(
      "the secret is the declared length",
      one.slice(TOKEN_PREFIX.length).split("_")[0]?.length === SECRET_LENGTH
    );
    check(
      "randomness comes from a CSPRNG, never Math.random",
      !readFileSync(SOURCE, "utf-8").includes("Math.random")
    );
  });

  await suite("the checksum rejects before the database is touched", () => {
    check(
      "a freshly minted token is well formed",
      minted.every(isWellFormedToken)
    );

    const body = one.slice(0, -CHECKSUM_LENGTH - 1);
    const mutated = `${body}_${"0".repeat(CHECKSUM_LENGTH)}`;
    check("a wrong checksum is refused", !isWellFormedToken(mutated));

    const flipped = one.replace(
      /^(noddle_pat_.)(.)/,
      (_m, head: string, next: string) => head + (next === "a" ? "b" : "a")
    );
    check("a single mutated character is refused", !isWellFormedToken(flipped));
    check("a truncated token is refused", !isWellFormedToken(one.slice(0, -1)));
    check("the prefix alone is refused", !isWellFormedToken(TOKEN_PREFIX));
    check("an empty string is refused", !isWellFormedToken(""));
    check(
      "a token without the prefix is refused",
      !isWellFormedToken(one.slice(TOKEN_PREFIX.length))
    );
  });
});
