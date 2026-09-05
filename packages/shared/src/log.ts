import { redactUrlCredentials } from "./redact.ts";

export type LogFields = Record<string, unknown>;

export interface Logger {
  error: (event: string, error: unknown, fields?: LogFields) => void;
  scoped: (base: LogFields) => Logger;
  write: (event: string, fields?: LogFields) => void;
}

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    return redactUrlCredentials(value);
  }
  if (value instanceof Error) {
    return redactUrlCredentials(value.message);
  }
  return value;
}

function emit(level: string, event: string, fields: LogFields): void {
  const line: LogFields = {
    evt: event,
    lvl: level,
    t: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      line[key] = clean(value);
    }
  }
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

function make(base: LogFields): Logger {
  return {
    error: (event, error, fields) =>
      emit("error", event, {
        ...base,
        ...fields,
        err: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    scoped: (extra) => make({ ...base, ...extra }),
    write: (event, fields) => emit("info", event, { ...base, ...fields }),
  };
}

export const log: Logger = make({});
