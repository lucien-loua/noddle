let pass = 0;
let fail = 0;
let currentSuite = "";
const cleanups: (() => void | Promise<void>)[] = [];

const GREEN = "\u001B[32m✓\u001B[0m";
const RED = "\u001B[31m✗\u001B[0m";

function prefix(): string {
  return currentSuite ? `${currentSuite} — ` : "";
}

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

export function ok(label: string): void {
  check(label, true);
}

export function ko(label: string): void {
  check(label, false);
}

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

export async function suite(
  name: string,
  fn: () => void | Promise<void>
): Promise<void> {
  const previous = currentSuite;
  currentSuite = name;
  console.log(`\n\u001B[1m${name}\u001B[0m`);
  try {
    await fn();
  } finally {
    currentSuite = previous;
  }
}

export function cleanup(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
}

export async function finish(): Promise<never> {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (error) {
      fail += 1;
      console.log(
        `  ${RED} cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

export async function runVerify(
  title: string,
  body: () => void | Promise<void>
): Promise<never> {
  const runtime =
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? `Node ${process.version}`
      : `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`;
  console.log(`\n\u001B[1m${runtime} — ${title}\u001B[0m`);
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
