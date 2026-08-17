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
  },
});
