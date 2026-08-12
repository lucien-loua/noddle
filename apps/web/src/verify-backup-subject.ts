// bun run apps/web/src/verify-backup-subject.ts
import { check, expectThrows, runVerify } from "@noddle/testing";
import {
  backupSubjectSchema,
  backupSubjectScopeId,
} from "@/lib/backup-subject";

const DB_ID = "11111111-1111-4111-8111-111111111111";
const SVC_ID = "22222222-2222-4222-8222-222222222222";

await runVerify("backup subject", () => {
  const database = backupSubjectSchema.parse({
    databaseId: DB_ID,
    kind: "database",
  });
  check("database subject scope id", backupSubjectScopeId(database) === DB_ID);

  const volume = backupSubjectSchema.parse({
    kind: "volume",
    serviceId: SVC_ID,
  });
  check("volume subject scope id", backupSubjectScopeId(volume) === SVC_ID);

  expectThrows(
    "rejects unknown kind",
    () => backupSubjectSchema.parse({ databaseId: DB_ID, kind: "stack" }),
    () => true
  );

  expectThrows(
    "database kind requires databaseId",
    () => backupSubjectSchema.parse({ kind: "database" }),
    () => true
  );

  expectThrows(
    "volume kind requires serviceId",
    () => backupSubjectSchema.parse({ kind: "volume" }),
    () => true
  );
});
