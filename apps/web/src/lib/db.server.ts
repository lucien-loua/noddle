// Pool Postgres du web.
//
// Distinct de celui du worker : deux processus, deux pools. Celui-ci sert des
// requêtes courtes de dashboard, là où le worker garde des connexions pendant
// des minutes.
import { createDatabase } from "@noddle/db";
import { env } from "@/lib/env.server";

export const db = createDatabase({ url: env.databaseUrl });
