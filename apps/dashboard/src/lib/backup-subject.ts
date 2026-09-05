import { z } from "zod";

export const backupSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    databaseId: z.uuid("Choose a database."),
    kind: z.literal("database"),
  }),
  z.object({
    kind: z.literal("volume"),
    serviceId: z.uuid("Choose a service."),
  }),
]);

export type BackupSubject = z.infer<typeof backupSubjectSchema>;

export type DatabaseBackupSubject = Extract<
  BackupSubject,
  { kind: "database" }
>;
export type VolumeBackupSubject = Extract<BackupSubject, { kind: "volume" }>;

export function backupSubjectScopeId(subject: BackupSubject): string {
  return subject.kind === "database" ? subject.databaseId : subject.serviceId;
}

export function databaseBackupSubject(
  databaseId: string
): DatabaseBackupSubject {
  return { databaseId, kind: "database" };
}

export function volumeBackupSubject(serviceId: string): VolumeBackupSubject {
  return { kind: "volume", serviceId };
}
