import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import jsPlugins from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";

const selectedJsPluginNames = new Set(["react-doctor"]);
const selectedJsPluginRulePrefixes = new Set(["react-doctor"]);

const selectedJsPlugins = {
  ...jsPlugins,
  jsPlugins: jsPlugins.jsPlugins?.filter((plugin) =>
    selectedJsPluginNames.has(plugin.name)
  ),
  overrides: jsPlugins.overrides?.map((override) => ({
    ...override,
    rules: Object.fromEntries(
      Object.entries(override.rules ?? {}).filter(([ruleName]) =>
        selectedJsPluginRulePrefixes.has(ruleName.split("/")[0] ?? ruleName)
      )
    ),
  })),
  rules: Object.fromEntries(
    Object.entries(jsPlugins.rules ?? {}).filter(([ruleName]) =>
      selectedJsPluginRulePrefixes.has(ruleName.split("/")[0] ?? ruleName)
    )
  ),
};

export default defineConfig({
  extends: [core, react, tanstack, vitest, selectedJsPlugins],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Off, and this one is load-bearing: it AUTO-FIXES, and `bun run fix`
    // runs on every edit through the PostToolUse hook. Several functions here
    // take a REQUIRED parameter that accepts undefined — `loadAppKey(raw)`,
    // `resolveBuildDir(clone, path)`, `stub(status, payload)` — and the
    // verifies pass `undefined` explicitly because that is the case under
    // test. Dropping it does not simplify anything: it produces
    // "Expected 2 arguments, but got 1", silently, on every save.
    "unicorn/no-useless-undefined": "off",

    // Off: contradicts AGENTS.md ("arrow functions for CALLBACKS and short
    // functions") and 89% of the codebase — 952 declarations against 122
    // expressions. 1226 findings, all of them style, none of them a defect.
    "func-style": "off",

    // Follows from the above: function declarations are hoisted, so using one
    // above its definition is not a hazard. 135 findings, all downstream of a
    // rule already turned off.
    "no-use-before-define": "off",

    // Off because the premise is absent: React Compiler is NOT enabled here
    // (nothing in apps/web/vite.config.ts or its dependencies). These rules
    // ask for manual memoization to be REMOVED on the grounds the compiler
    // will redo it — with no compiler, that is a performance regression
    // dressed as a cleanup. Turn them back on the day the compiler lands.
    "react-doctor/react-compiler-no-manual-memoization": "off",
    "react/react-compiler": "off",

    // The ssh2 / dockerode seam is built ON these. `connect()` bridges an
    // EventEmitter to a promise, which is what `new Promise` is for and the
    // only thing that does it; the executor also wraps callback APIs by
    // necessity, not by preference. See ADR-0015 and ssh-executor/index.ts.
    "promise/avoid-new": "off",
    "promise/param-names": "off",
    "promise/prefer-await-to-callbacks": "off",

    // Off: the `async` is a SIGNATURE, not an intention. TanStack Start's
    // `createServerFn().handler()` types its argument as async, so every
    // handler that delegates without awaiting trips this.
    "require-await": "off",

    // Off, and this is the rule the repo had already answered: 144
    // `biome-ignore` comments across 79 files document sequential awaits as
    // deliberate — polling a server's startup, running cleanups in order,
    // deploy steps that must not race. In infrastructure code the sequence
    // IS the logic. Those comments went inert with the switch; this keeps
    // their decision in force from one place.
    "no-await-in-loop": "off",
    "react-doctor/async-await-in-loop": "off",

    // Off: every regex here reads ASCII the tooling produced — docker
    // output, YAML keys, install.sh text. The `u` flag buys nothing against
    // that and turns some existing escapes into syntax errors.
    "require-unicode-regexp": "off",
    "prefer-named-capture-group": "off",

    // Off, after checking all 15 findings one by one. The rule looks for
    // `queryClient.invalidateQueries`; this app refreshes through TanStack
    // Router (ADR-0009) and a `refreshScope()` helper, which it cannot see.
    // Measured: 7 already invalidated, 3 navigate away or redirect off-site,
    // 1 detects completion by polling the running version on purpose, 3 queue
    // asynchronous worker jobs, and exactly ONE was a real omission —
    // container-actions' service restart, fixed in the same commit.
    // 14 of 15 findings were noise, and noise around a real defect is how the
    // real one gets skipped.
    "react-doctor/query-mutation-missing-invalidation": "off",

    // Off reluctantly — this rule finds real bugs elsewhere, and inline
    // suppression does NOT work for it (neither oxlint-disable-next-line nor
    // the eslint form takes effect), so targeted silencing was not available.
    //
    // Measured: 24 of the 27 findings name the same dependency, `form`. The
    // effects deliberately depend on `form.reset` — the stable method —
    // because TanStack Form's object identity changes on every render.
    // Adding `form` would re-run the effect each render and reset the form in
    // a loop: a regression, not a fix. database-configuration.tsx still
    // carries the biome-ignore that said so before the switch.
    //
    // The 3 that are NOT about `form` are real and now go unflagged:
    //   backups/panel.tsx:100-101   missing `subject`, then unnecessary
    //   backups/config-dialog.tsx:329  unnecessary dependency
    "react-hooks/exhaustive-deps": "off",

    // Off: it contradicts the standard this repo writes down. All 22 findings
    // say the same thing — "use default import for module `node:path`" — and
    // AGENTS.md asks for the opposite: "Prefer specific imports over namespace
    // imports". `import { join } from "node:path"` IS the specific form, it is
    // what every file here uses, and it is what tree-shaking wants.
    "unicorn/import-style": "off",

    // ── Style opinions this codebase does not share ──────────────────────
    //
    // `(await import("@wterm/react")).Terminal` is how a dynamic import reads;
    // hoisting it to a temporary says nothing the reader did not know.
    "unicorn/no-await-expression-member": "off",
    // `.then()` on a fire-and-forget cache refresh is not a readability
    // problem, and the alternative is an async IIFE wrapping one line.
    "promise/prefer-await-to-then": "off",
    // `== null` is ONE check for null-or-undefined, used deliberately here.
    // `eqeqeq` and `no-eq-null` together forbid exactly that idiom.
    "eqeqeq": "off",
    "no-eq-null": "off",
    // The comments this flags are the ones CLAUDE.md asks for — the "why"
    // next to the line it explains.
    "no-inline-comments": "off",
    // Key order is a formatter's business, and oxfmt does not reorder.
    "sort-keys": "off",
    // Naming a handler `onOpen` rather than `handleOpen` is a convention this
    // repo did not adopt, and the rule cannot tell the two apart.
    "react/jsx-handler-names": "off",
    "unicorn/prefer-ternary": "off",

    // ── Micro-optimisation advice, not defects ───────────────────────────
    //
    // These suggest faster shapes for code that is not on any hot path: a
    // Set lookup instead of Array#includes over five items, two loops
    // merged into one. Real advice, wrong altitude — it buries the rules
    // below that name actual bugs.
    "react-doctor/js-set-map-lookups": "off",
    "react-doctor/js-combine-iterations": "off",
    "react-doctor/js-index-maps": "off",
    "react-doctor/js-cache-property-access": "off",
  },
});
