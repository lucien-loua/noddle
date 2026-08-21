/** Longest a resource identity may be, matching `serviceNameSchema`. */
const MAX = 48;

const SEPARATORS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const COMBINING = /\p{Diacritic}/gu;

/**
 * A DNS-safe identity derived from whatever a human typed.
 *
 * The identity has to be lowercase letters, digits and dashes — it becomes a
 * Swarm service name and a hostname. Rather than refuse "Start" and make the
 * user solve that themselves, the name they typed is kept as the display name
 * and this derives the identity beside it.
 *
 * Accents are folded rather than dropped, so "Café" becomes "cafe" and not
 * "caf". An input with nothing usable in it (emoji, CJK) yields "", and the
 * caller decides the fallback — silently inventing one here would produce a
 * resource whose identity has no relationship to its name.
 */
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

/**
 * The first slug in `taken`'s gap, so a second "Start" lands on `start-2`.
 *
 * The unique index is per environment, so `taken` must be that environment's
 * names — deduplicating globally would number resources that never collide.
 */
export function uniqueResourceSlug(
  desired: string,
  taken: Iterable<string>
): string {
  const used = new Set(taken);
  if (!used.has(desired)) {
    return desired;
  }
  let n = 2;
  // The suffix has to fit INSIDE the cap, or two long names would both
  // truncate to the same 48 characters and collide again.
  while (used.has(`${desired.slice(0, MAX - `-${n}`.length)}-${n}`)) {
    n += 1;
  }
  return `${desired.slice(0, MAX - `-${n}`.length)}-${n}`;
}
