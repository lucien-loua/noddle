/**
 * Types for the TanStack Start build that `server.ts` loads at runtime.
 *
 * The JS lives at `./dist/server/server.js` after `vite build` — absent in a
 * fresh checkout. This module declaration keeps the production entry
 * typecheckable without requiring a prior build.
 *
 * It lives under `types/` and NOT next to `server.ts`: Bun's resolver picks
 * a sibling `start-handler.d.ts` over the `#start-handler` entry in
 * package.json `imports`, and `bun run start` then dies on "Missing
 * 'default' export" in a file that has no runtime at all.
 */
declare module "#start-handler" {
  const handler: {
    fetch: (request: Request) => Response | Promise<Response>;
  };
  export default handler;
}
