import { resolveDestination } from "@noddle/backup";
import { downloadStream, objectExists } from "@noddle/backup-store";

import type { DeployContext } from "#runtime-context";

export interface RestoreSource {
  destinationId: string | null;
  objectKey: string;
}

export interface RestoreSubject<TRequest, TLoaded> {
  apply: (
    ctx: DeployContext,
    loaded: TLoaded,
    body: NodeJS.ReadableStream
  ) => Promise<void>;
  load: (ctx: DeployContext, request: TRequest) => Promise<TLoaded>;
  missingObjectTarget: string;
  resolveSource: (
    ctx: DeployContext,
    request: TRequest,
    loaded: TLoaded
  ) => Promise<RestoreSource>;
  safetyBackup?: (
    ctx: DeployContext,
    loaded: TLoaded,
    resolved: Awaited<ReturnType<typeof resolveDestination>>
  ) => Promise<void>;
}

export async function runRestorePipeline<TRequest, TLoaded>(
  subject: RestoreSubject<TRequest, TLoaded>,
  ctx: DeployContext,
  request: TRequest
): Promise<void> {
  const loaded = await subject.load(ctx, request);
  const { destinationId, objectKey } = await subject.resolveSource(
    ctx,
    request,
    loaded
  );

  const resolved = await resolveDestination(ctx.db, ctx.appKey, destinationId);

  // BEFORE any destructive action. The backup row is not proof that the
  // object is still there.
  if (!(await objectExists(resolved.destination, objectKey))) {
    throw new Error(
      `object ${objectKey} is missing from the bucket: restore refused before touching the ${subject.missingObjectTarget}`
    );
  }

  if (subject.safetyBackup) {
    await subject.safetyBackup(ctx, loaded, resolved);
  }

  const body = await downloadStream(resolved.destination, objectKey);
  await subject.apply(ctx, loaded, body);
}
