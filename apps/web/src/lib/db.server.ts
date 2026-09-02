import { createDatabase } from "@noddle/db";

import { env } from "@/lib/env.server";

export const db = createDatabase({ url: env.databaseUrl });
