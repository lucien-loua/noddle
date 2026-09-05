import { log } from "@noddle/shared/log";
import type { LogFields } from "@noddle/shared/log";

export async function timed<T>(
  event: string,
  fields: LogFields,
  body: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await body();
    log.write(event, { ...fields, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    log.error(`${event}.failed`, error, {
      ...fields,
      ms: Date.now() - startedAt,
    });
    throw error;
  }
}
