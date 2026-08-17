import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The build's commit, frozen INTO the bundle.
  //
  // Reading it via `process.env.NODDLE_COMMIT` at runtime doesn't work: the
  // variable is indeed present in the container's environment (measured
  // with `docker exec … echo $NODDLE_COMMIT`), but the built bundle
  // contains NEITHER the name NOR the value — static access to
  // `process.env` gets replaced at build time, and it had been replaced
  // with nothing. The screen therefore showed "unknown" on an image that
  // was in fact correctly tagged.
  //
  // Declaring it here isn't a workaround: the commit IS a build-time fact,
  // and `define` is how a build-time fact gets frozen. Above all, it makes
  // the inlining explicit rather than accidental — the value can no longer
  // silently disappear.
  define: {
    "process.env.NODDLE_COMMIT": JSON.stringify(
      process.env.NODDLE_COMMIT ?? ""
    ),
  },
  // `ssh2` bundles NATIVE ADDONS (`sshcrypto.node`, and `cpufeatures.node`
  // via `cpu-features`). A `.node` file is a compiled binary: no bundler
  // can inline it, and Rolldown fails with "stream did not contain valid
  // UTF-8" — a message that names neither ssh2 nor the reason.
  //
  // The web app reaches ssh2 through `@noddle/ssh-executor/keys`, which
  // builds the library's key pairs. Externalizing it is the CORRECT form,
  // not a workaround: the module is then loaded at runtime from
  // node_modules, which the image keeps (it runs `bun run server.ts` from
  // the source tree, with no prune step).
  //
  // Only the SERVER pass is affected; the client bundle never sees ssh2,
  // and it already built successfully ("✓ 5963 modules transformed")
  // before the next pass failed.
  // The same rejection, on the CLIENT side: the optimizer follows
  // `@noddle/ssh-executor` (a workspace package, hence scanned) all the way
  // to `ssh2`, and trips on its addons. We exclude the package that LEADS
  // there, not just ssh2: it's the one the scanner encounters first.
  optimizeDeps: {
    exclude: ["@noddle/ssh-executor", "ssh2", "cpu-features"],
  },
  plugins: [
    tailwindcss(),
    // Order matters: the Start plugin must come before the React plugin.
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    hmr: {
      clientPort: Number(process.env.VITE_HMR_PORT ?? 24_678),
      host: "localhost",
      port: Number(process.env.VITE_HMR_PORT ?? 24_678),
    },
    // Bun owns the public :3000 in `scripts/dev-web.ts` and reverse-proxies
    // here. HMR keeps a dedicated port so its upgrades do not collide with
    // terminal WebSockets on the Bun front.
    host: "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    strictPort: true,
  },
  ssr: {
    external: ["ssh2", "cpu-features"],
    // `external` covers the BUILD. The dev server's dependency optimizer is
    // a separate path, and it pre-bundles anyway — so `vite dev` used to
    // fail on startup with the exact same "stream did not contain valid
    // UTF-8", as soon as the `node_modules/.vite` cache was missing.
    // Invisible as long as the cache exists, i.e. until the first `clone`
    // or the first cleanup.
    optimizeDeps: { exclude: ["ssh2", "cpu-features"] },
  },
});
