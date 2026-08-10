# TanStack Start server functions for RPC

The RPC layer is **TanStack Start `createServerFn`**, not tRPC. Start already
gives end-to-end type safety; two RPC layers is waste. tRPC only if a public API
or CLI ever needs a versioned contract outside the app.

**Status:** accepted
