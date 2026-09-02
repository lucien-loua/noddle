// tier: pure
import { check, runVerify } from "@noddle/testing";

import {
  assertSafeShellIdentifier,
  SAFE_SHELL_IDENTIFIER,
} from "./shell-identifier";

await runVerify(
  "shell identifier (the one charset every compose key, volume name and Zod schema shares)",
  () => {
    check(
      "letters, digits, dots, underscores and hyphens pass",
      SAFE_SHELL_IDENTIFIER.test("my-volume_1.2")
    );
    check("empty string is rejected", !SAFE_SHELL_IDENTIFIER.test(""));
    check(
      "cannot start with a dot, underscore or hyphen",
      !SAFE_SHELL_IDENTIFIER.test(".hidden") &&
        !SAFE_SHELL_IDENTIFIER.test("_x") &&
        !SAFE_SHELL_IDENTIFIER.test("-x")
    );
    check(
      "shell metacharacters are rejected — this IS the injection guard",
      !SAFE_SHELL_IDENTIFIER.test("a; rm -rf /") &&
        !SAFE_SHELL_IDENTIFIER.test("a$(whoami)") &&
        !SAFE_SHELL_IDENTIFIER.test("a`whoami`") &&
        !SAFE_SHELL_IDENTIFIER.test("a && b") &&
        !SAFE_SHELL_IDENTIFIER.test("a|b") &&
        !SAFE_SHELL_IDENTIFIER.test("a b") &&
        !SAFE_SHELL_IDENTIFIER.test("'a'")
    );

    check(
      "assertSafeShellIdentifier passes a safe value through silently",
      (() => {
        assertSafeShellIdentifier("cache-db_1", "volume name");
        return true;
      })()
    );
    check(
      "assertSafeShellIdentifier throws on an unsafe value, naming the label and the value",
      (() => {
        try {
          assertSafeShellIdentifier("a; rm -rf /", "volume name");
          return false;
        } catch (error) {
          return (
            error instanceof Error &&
            error.message.includes("volume name") &&
            error.message.includes("a; rm -rf /")
          );
        }
      })()
    );
  }
);
