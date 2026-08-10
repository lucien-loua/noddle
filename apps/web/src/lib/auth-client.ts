import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "@/lib/permissions";

export const authClient = createAuthClient({
  // The SAME roles as the server, imported from the same file. Two
  // diverging definitions would give an interface that offers an action
  // the server refuses — or worse, that hides one it allows.
  plugins: [adminClient({ ac, roles })],
});
