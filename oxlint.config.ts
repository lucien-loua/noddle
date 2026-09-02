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
    selectedJsPluginNames.has(typeof plugin === "string" ? plugin : plugin.name)
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
  overrides: [
    {
      files: ["**/verify*.ts"],
      rules: { complexity: "off" },
    },
    {
      files: ["packages/db/src/schema/index.ts"],
      rules: { "no-barrel-file": "off" },
    },
    {
      files: ["scripts/fixtures/**"],
      rules: { "unicorn/prefer-module": "off" },
    },
    {
      files: ["packages/ssh-executor/src/index.ts"],
      rules: {
        "max-classes-per-file": "off",
        "promise/no-promise-in-callback": "off",
      },
    },
    {
      files: ["apps/web/src/components/terminal-dialog.tsx"],
      rules: { "react-doctor/no-prop-callback-in-effect": "off" },
    },
    {
      files: ["apps/web/src/components/ui/**"],
      rules: {
        complexity: "off",
        "prefer-destructuring": "off",
        "react-doctor/no-giant-component": "off",
        "react/hook-use-state": "off",
        "unicorn/consistent-function-scoping": "off",
        "unicorn/no-array-reduce": "off",
        "unicorn/prefer-query-selector": "off",
        "react-doctor/no-chain-state-updates": "off",
        "react-doctor/no-effect-chain": "off",
        "class-methods-use-this": "off",
        "jsx-a11y/click-events-have-key-events": "off",
        "jsx-a11y/label-has-associated-control": "off",
        "jsx-a11y/no-noninteractive-element-interactions": "off",
        "no-param-reassign": "off",
        "no-shadow": "off",
        "react-doctor/no-array-index-as-key": "off",
        "react-doctor/rendering-svg-precision": "off",
        "react/button-has-type": "off",
        "react/jsx-no-constructed-context-values": "off",
        "react/no-object-type-as-default-prop": "off",
        "unicorn/no-document-cookie": "off",
      },
    },
  ],

  rules: {
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-empty-function": ["error", { allow: ["arrowFunctions"] }],

    "unicorn/no-useless-undefined": "off",

    "func-style": "off",

    "no-use-before-define": "off",

    "react-doctor/react-compiler-no-manual-memoization": "off",
    "react/react-compiler": "off",

    "promise/avoid-new": "off",
    "promise/param-names": "off",
    "promise/prefer-await-to-callbacks": "off",

    "require-await": "off",

    "no-await-in-loop": "off",
    "react-doctor/async-await-in-loop": "off",

    "require-unicode-regexp": "off",
    "prefer-named-capture-group": "off",

    "react-doctor/query-mutation-missing-invalidation": "off",

    "react-hooks/exhaustive-deps": "off",

    "unicorn/import-style": "off",

    "react-doctor/async-parallel": "off",
    "react-doctor/server-sequential-independent-await": "off",
    "react-doctor/no-derived-useState": "off",
    "no-bitwise": "off",
    "typescript/ban-types": "off",
    "class-methods-use-this": "off",

    "jsx-a11y/prefer-tag-over-role": "off",

    "react/hook-use-state": "off",

    "unicorn/prefer-number-coercion": "off",

    "react-doctor/effect-needs-cleanup": "off",

    "react/no-unstable-nested-components": "off",

    "sort-keys": "off",

    "unicorn/no-await-expression-member": "off",
    "promise/prefer-await-to-then": "off",
    eqeqeq: "off",
    "no-eq-null": "off",
    "no-inline-comments": "off",
    "react/jsx-handler-names": "off",
    "unicorn/prefer-ternary": "off",

    "react-doctor/js-set-map-lookups": "off",
    "react-doctor/js-combine-iterations": "off",
    "react-doctor/js-index-maps": "off",
    "react-doctor/js-cache-property-access": "off",
  },
});
