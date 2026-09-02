const MAX = 48;

const SEPARATORS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const COMBINING = /\p{Diacritic}/gu;

export function toResourceSlug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(SEPARATORS, "-")
    .replace(EDGE_DASHES, "")
    .slice(0, MAX)
    .replace(EDGE_DASHES, "");
}

export function uniqueResourceSlug(
  desired: string,
  taken: Iterable<string>
): string {
  const used = new Set(taken);
  if (!used.has(desired)) {
    return desired;
  }
  let n = 2;
  while (used.has(`${desired.slice(0, MAX - `-${n}`.length)}-${n}`)) {
    n += 1;
  }
  return `${desired.slice(0, MAX - `-${n}`.length)}-${n}`;
}
