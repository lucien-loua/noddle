/**
 * Shared interface for every `verify*.ts` script.
 *
 * Counting, exit policy, target resolution and cleanup live here so a
 * forgotten `else` cannot silently pass, and so VM-free suites can run in
 * CI under one command.
 */

let pass = 0;
let fail = 0;
let currentSuite = "";
const cleanups: Array<() => void | Promise<void>> = [];

const GREEN = "\x1b[32m✓\x1b[0m";
const RED = "\x1b[31m✗\x1b[0m";

function prefix(): string {
  return currentSuite ? `${currentSuite} — ` : "";
}

/** Record a passing check. */
export function check(
  label: string,
  condition: boolean,
  detail?: string
): void {
  if (condition) {
    pass += 1;
    console.log(`  ${GREEN} ${prefix()}${label}`);
    return;
  }
  fail += 1;
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  ${RED} ${prefix()}${label}${suffix}`);
}

/** Alias used by older scripts — prefer `check`. */
export function ok(label: string): void {
  check(label, true);
}

/** Alias used by older scripts — prefer `check`. */
export function ko(label: string): void {
  check(label, false);
}

/** Expects `fn` to throw. A silent pass is a lying test. */
export function expectThrows(
  label: string,
  fn: () => unknown,
  match?: (err: unknown) => boolean
): void {
  try {
    fn();
    check(`${label} — SHOULD HAVE FAILED`, false);
  } catch (e) {
    if (match && !match(e)) {
      check(
        label,
        false,
        `wrong error: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    check(label, true);
  }
}

/** Async variant of `expectThrows`. */
export async function expectThrowsAsync(
  label: string,
  fn: () => Promise<unknown>,
  match?: (err: unknown) => boolean
): Promise<void> {
  try {
    await fn();
    check(`${label} — SHOULD HAVE FAILED`, false);
  } catch (e) {
    if (match && !match(e)) {
      check(
        label,
        false,
        `wrong error: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    check(label, true);
  }
}

/**
 * Groups related checks under a printed heading. Failures inside still
 * count toward the process exit code.
 */
export async function suite(
  name: string,
  fn: () => void | Promise<void>
): Promise<void> {
  const previous = currentSuite;
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  try {
    await fn();
  } finally {
    currentSuite = previous;
  }
}

/**
 * Register work that must run after all suites, even on failure
 * (disconnect, drop temp files, …). Cleanup failures are reported.
 */
export function cleanup(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
}

/**
 * Resolve the spike / verify target host once.
 * Override with `NODDLE_VERIFY_HOST`; default matches the historical
 * hardcoded value used across worker verifies.
 */
export function target(): { host: string } {
  return { host: process.env.NODDLE_VERIFY_HOST ?? "192.168.252.3" };
}

export function counts(): { fail: number; pass: number } {
  return { fail, pass };
}

/**
 * Run cleanups, print the summary, and exit. Call once at the end of a
 * verify script (or let `runVerify` do it).
 */
export async function finish(): Promise<never> {
  for (const fn of cleanups) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: cleanups must run in order.
      await fn();
    } catch (e) {
      fail += 1;
      console.log(
        `  ${RED} cleanup failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * Entry helper: print a runtime banner, run the body, then `finish`.
 */
export async function runVerify(
  title: string,
  body: () => void | Promise<void>
): Promise<never> {
  const runtime =
    typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
      ? `Node ${process.version}`
      : `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`;
  console.log(`\n\x1b[1m${runtime} — ${title}\x1b[0m`);
  try {
    await body();
  } catch (e) {
    fail += 1;
    console.log(
      `  ${RED} suite crashed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return await finish();
}
