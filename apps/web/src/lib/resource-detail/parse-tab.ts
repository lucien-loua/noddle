export function parseDetailTab<T extends string>(
  value: unknown,
  allowed: readonly T[],
  legacy?: Record<string, T>,
): T | undefined {
  if (typeof value !== "string") {
    return;
  }
  if (allowed.includes(value as T)) {
    return value as T;
  }
  return legacy?.[value];
}

export function isDetailTab<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}
