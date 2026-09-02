// tier: pure
import { check, runVerify } from "@noddle/testing";

import { toResourceSlug, uniqueResourceSlug } from "./slug";

await runVerify("resource slug (a typed name becomes an identity)", () => {
  check("case is folded", toResourceSlug("Start") === "start");
  check("spaces become dashes", toResourceSlug("My App") === "my-app");
  check(
    "accents are FOLDED, not dropped — 'caf' would be a different word",
    toResourceSlug("Café") === "cafe"
  );
  check(
    "runs of punctuation collapse to one dash",
    toResourceSlug("a  --  b") === "a-b"
  );
  check(
    "it cannot start or end with a dash",
    toResourceSlug("-lead-") === "lead" && toResourceSlug("...x...") === "x"
  );
  check(
    "nothing usable yields EMPTY, so the caller decides",
    toResourceSlug("🎉") === ""
  );
  check("it is capped at 48", toResourceSlug("a".repeat(80)).length === 48);
  check(
    "a truncation cannot leave a trailing dash",
    !toResourceSlug(`${"a".repeat(47)}-tail`).endsWith("-")
  );

  check(
    "a free slug is returned as is",
    uniqueResourceSlug("api", []) === "api"
  );
  check(
    "a taken slug gets the first free number",
    uniqueResourceSlug("api", ["api"]) === "api-2" &&
      uniqueResourceSlug("api", ["api", "api-2"]) === "api-3"
  );
  check(
    "the suffix fits INSIDE the cap, so two long names cannot re-collide",
    uniqueResourceSlug("a".repeat(48), ["a".repeat(48)]).length <= 48
  );
});
