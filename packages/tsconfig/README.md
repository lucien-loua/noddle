# @noddle/tsconfig

Shared TypeScript config. Every package extends it:

```json
{
  "extends": "@noddle/tsconfig/base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src/**/*.ts"]
}
```

Comments are not in `base.json`: editors and oxfmt treat `.json` as strict JSON, and comments break parsing there. Non-obvious choices are therefore documented here.

## `erasableSyntaxOnly`

The one truly structural setting, and it is not cosmetic.

It forbids any TypeScript syntax that **emits code** instead of disappearing with the types: parameter properties (`constructor(private readonly x: T)`), `enum`, `namespace`, legacy decorators.

That is exactly the constraint of Node's _strip-only_ mode, which strips annotations without transforming anything. And `apps/worker` runs on Node — decided by measurement, not preference: `dockerode` does not work on Bun through an SSH tunnel (see `.claude/CLAUDE.md`).

Without this flag, the error only shows up at runtime, as an `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on module load. It has already cost a round-trip on a `constructor(readonly host: string)`.

## `allowImportingTsExtensions`

Imports carry the `.ts` extension explicitly (`from "./index.ts"`). Node in strip-only mode and Bun both require it.
