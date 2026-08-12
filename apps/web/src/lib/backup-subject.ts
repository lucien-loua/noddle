import { z } from "zod";

/**
 * WHO owns these backups: a database dump schedule, or a service volume archive.
 *
 * Same discriminant pattern as `EnvVarTarget` — exactly one scope id, never both.
 */
export const backupSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ databaseId: z.uuid(), kind: z.literal("database") }),
  z.object({ kind: z.literal("volume"), serviceId: z.uuid() }),
]);

export type BackupSubject = z.infer<typeof backupSubjectSchema>;

export function backupSubjectScopeId(subject: BackupSubject): string {
  return subject.kind === "database" ? subject.databaseId : subject.serviceId;
}
