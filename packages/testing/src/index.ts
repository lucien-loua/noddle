/**
 * Shared interface for every `verify*.ts` script.
 *
 * Counting, exit policy and cleanup live here so a forgotten `else`
 * cannot silently pass, and so VM-free suites can run in CI under one
 * command.
 */

let pass = 0;
let fail = 0;
let currentSuite = "";
const cleanups: (() => void | Promise<void>)[] = [];

const GREEN = "\x1B[32m✓\x1B[0m";
const RED = "\x1B[31m✗\x1B[0m";

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
  } catch (error) {
    if (match && !match(error)) {
      check(
        label,
        false,
        `wrong error: ${error instanceof Error ? error.message : String(error)}`
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
  } catch (error) {
    if (match && !match(error)) {
      check(
        label,
        false,
        `wrong error: ${error instanceof Error ? error.message : String(error)}`
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
  console.log(`\n\u001b[1m${name}\x1B[0m`);
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
    } catch (error) {
      fail += 1;
      console.log(
        `  ${RED} cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(`\n\x1B[1mpassed ${pass}, failed ${fail}\x1B[0m\n`);
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
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? `Node ${process.version}`
      : `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`;
  console.log(`\n\x1B[1m${runtime} — ${title}\x1B[0m`);
  try {
    await body();
  } catch (error) {
    fail += 1;
    console.log(
      `  ${RED} suite crashed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return await finish();
}
