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
      // Verify suites are FLAT: a list of independent checks, each a `&&`
      // chain of assertions. Cyclomatic complexity counts every `&&`, so a
      // bench scores 27 for having 27 things to prove — the metric measures
      // its length, not its branching. Splitting one into helpers to satisfy
      // the count would hide which assertion failed, which is the only thing
      // a verify has to tell you.
      files: ["**/verify*.ts"],
      rules: { complexity: "off" },
    },
    {
      // Drizzle's `drizzle(client, { schema })` takes the WHOLE namespace —
      // that object is how `db.query.<table>` and the relational API exist at
      // all. This barrel is the schema, not a convenience re-export.
      files: ["packages/db/src/schema/index.ts"],
      rules: { "no-barrel-file": "off" },
    },
    {
      // Build fixtures are repositories under test: this one is CommonJS
      // precisely to check that railpack detects a plain CJS app. Modernising
      // it would delete the case.
      files: ["scripts/fixtures/**"],
      rules: { "unicorn/prefer-module": "off" },
    },
    {
      // `SshSocketAgent` exists only to give `SshError`'s module its transport;
      // it is not exported, and a file of its own would publish an internal.
      // `no-promise-in-callback` fires at the ssh2 boundary, where the library
      // hands back a stream through a callback and the consumer is a promise —
      // the seam between the two APIs, which has to live somewhere.
      files: ["packages/ssh-executor/src/index.ts"],
      rules: {
        "max-classes-per-file": "off",
        "promise/no-promise-in-callback": "off",
      },
    },
    {
      // The terminal's status IS the effect's product: connecting, open,
      // closed are transitions of the socket the effect owns, and the parent
      // renders them. There is no state to lift — the socket is the state.
      files: ["apps/web/src/components/terminal-dialog.tsx"],
      rules: { "react-doctor/no-prop-callback-in-effect": "off" },
    },
    {
      // `apps/web/src/components/ui` is the shadcn preset — `components.json`
      // points its "ui" alias there, and `shadcn add` overwrites these files.
      // CLAUDE.md is explicit: nothing the preset provides is rewritten by
      // hand, so restyling them is work the next component install undoes.
      //
      // 78 of 186 findings live here. What is switched off is SHAPE — nested
      // ternaries, function length, hook naming. What stays on names defects:
      // const-comparisons, no-accumulating-spread, no-shadow. Vendored code
      // being ours to leave alone does not make it ours to stop reading.
      files: ["apps/web/src/components/ui/**"],
      rules: {
        complexity: "off",
        "prefer-destructuring": "off",
        "react-doctor/no-giant-component": "off",
        "react/hook-use-state": "off",
        "unicorn/consistent-function-scoping": "off",
        "unicorn/no-array-reduce": "off",
        "unicorn/prefer-query-selector": "off",
        // All six findings are the combobox's keyboard navigation: which
        // option is highlighted, scrolling it into view, resetting it when
        // the filtered list changes. Fixing them means changing focus
        // behaviour in a file `shadcn add` overwrites, and neither the
        // keyboard path nor the result can be exercised from here.
        "react-doctor/no-chain-state-updates": "off",
        "react-doctor/no-effect-chain": "off",
        // The rest of what shadcn ships here: a JSX default prop, an index
        // key, a label without a control, a cookie write, a parameter
        // reassigned, a context value built inline. All upstream's, all
        // reverted by the next `shadcn add`.
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

    // Rules whose findings this repo answers the same way everywhere, so the
    // answer belongs here rather than repeated above each line.
    //
    // async-parallel / server-sequential-independent-await: the benches read
    // a value before an action and again after, and seed rows whose creation
    // ORDER is the fixture — sweep.ts picks a rollback target with
    // `lt(createdAt)`. Running those together deletes what they measure.
    "react-doctor/async-parallel": "off",
    "react-doctor/server-sequential-independent-await": "off",
    // The prune switch holds an optimistic copy of its prop and is keyed on
    // it, so it remounts rather than going stale — which the rule cannot see.
    "react-doctor/no-derived-useState": "off",
    // `^ 0x01` flips one bit, which IS the tamper the crypto bench performs.
    "no-bitwise": "off",
    // `string & {}` keeps the literal states in autocomplete while accepting
    // one Docker adds later.
    "typescript/ban-types": "off",
    // The log bus reads a module-scope redis client; `this` would add nothing.
    "class-methods-use-this": "off",

    // Off for what it still finds, after fixing the 11 that were real: every
    // remaining one is either textbook ARIA or a role this repo adds to a
    // PRESET component from outside, which is the only place it can.
    //
    //   `role="img"` on a <span aria-label> is the standard way to give a
    //   coloured status dot a name — <img> would need a source it has none of.
    //   `role="navigation"` on <SidebarContent> and `role="listitem"` on
    //   <Item> are documented in place: ui/ is overwritten by `shadcn add`,
    //   so the landmark has to be attached from the caller.
    //
    // 11 were genuine and are fixed: <p> and <span> live regions became
    // <output>, each with its display made explicit.
    "jsx-a11y/prefer-tag-over-role": "off",

    // Off after reading all 4, each deliberate. Two hold values named
    // `interval` and `timeout`, so the setters the rule wants — `setInterval`,
    // `setTimeout` — would shadow the browser globals. One keeps the raw
    // setter as `setThemeState` because `setTheme` is the wrapper it exports.
    // The fourth destructures no setter at all: `const [queryClient] =
    // useState(() => new QueryClient(...))` is the create-once idiom.
    "react/hook-use-state": "off",

    // Off, and this one was measured the hard way. It asks for
    // `Math.trunc(Number(x))` where `Number.parseInt(x, 10)` stands — not the
    // same function: parseInt reads the leading digits, Number wants the whole
    // string. build-engine compares caps written WITH their unit ("960m"), so
    // Number() returns NaN, every comparison silently flips, and the bench
    // went from 15/15 to 14/1. An auto-fix applied this once already.
    "unicorn/prefer-number-coercion": "off",

    // Off after reading all 3: each effect DOES clean up, by closing the
    // EventSource or the WebSocket the listeners are attached to — which
    // discards them with it. The rule looks for a literal removeEventListener
    // and cannot see that `source.close()` is the complete teardown.
    "react-doctor/effect-needs-cleanup": "off",

    // Off after reading all 10 findings: every one is a TanStack Table `cell`
    // renderer, which is that library's required shape — `cell: (info) =>
    // JSX` — and they sit inside useMemo, so nothing is recreated per render.
    // React never mounts them as components; the table calls them. The rule
    // cannot tell a cell renderer from a nested component, and ten permanent
    // false positives would drown the real one if it ever appeared.
    "react/no-unstable-nested-components": "off",

    // Off, and this time measured rather than assumed. Neither setting fits:
    // the default compares by code point (4 findings — `banReason` must
    // precede `banned` because "R" < "n"), case-insensitive gives 10. The
    // repository is ordered the way a person reads, which is neither. And the
    // objects it flags are grouped WITH their rationale — the Drizzle column
    // blocks, this rules map — where alphabetical order would scatter each
    // explanation away from what it explains.
    "sort-keys": "off",

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
    eqeqeq: "off",
    "no-eq-null": "off",
    // The comments this flags are the ones CLAUDE.md asks for — the "why"
    // next to the line it explains.
    "no-inline-comments": "off",
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
