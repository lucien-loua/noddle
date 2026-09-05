import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "node_modules/**",
      "**/node_modules/**",
      "apps/dashboard/dist/**",
      "apps/dashboard/.vinxi/**",
      "apps/dashboard/.tanstack/**",
      "apps/dashboard/src/routeTree.gen.ts",
      "apps/worker/dist/**",
      "packages/db/dist/**",
    ],
    semi: true,
    singleQuote: false,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: [
      "node_modules/**",
      "**/node_modules/**",
      "apps/dashboard/dist/**",
      "apps/dashboard/.vinxi/**",
      "apps/dashboard/.tanstack/**",
      "apps/dashboard/src/routeTree.gen.ts",
      "apps/worker/dist/**",
      "packages/db/dist/**",
    ],
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  staged: {
    "*.{js,ts,jsx,tsx,vue,svelte,json,jsonc,css,md}": "vp check --fix",
  },
});
