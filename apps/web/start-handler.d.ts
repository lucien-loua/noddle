/**
 * Types for the TanStack Start build that `server.ts` loads at runtime.
 *
 * The JS lives at `./dist/server/server.js` after `vite build` — absent in a
 * fresh checkout. This module declaration keeps the production entry
 * typecheckable without requiring a prior build.
 */
declare module "#start-handler" {
  const handler: {
    fetch: (request: Request) => Response | Promise<Response>;
  };
  export default handler;
}
