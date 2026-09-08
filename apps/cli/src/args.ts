export const COMMANDS = [
  "whoami",
  "servers",
  "services",
  "deploy",
  "status",
  "logs",
] as const;

export type Command = (typeof COMMANDS)[number];

export const VALUE_FLAGS = ["url", "token", "timeout"] as const;
export const BOOLEAN_FLAGS = ["json", "wait", "help", "version"] as const;

export interface ParsedArgs {
  command: Command | null;
  flags: {
    help: boolean;
    json: boolean;
    timeout?: string;
    token?: string;
    url?: string;
    version: boolean;
    wait: boolean;
  };
  positional: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function isValueFlag(name: string): name is (typeof VALUE_FLAGS)[number] {
  return (VALUE_FLAGS as readonly string[]).includes(name);
}

function isBooleanFlag(name: string): name is (typeof BOOLEAN_FLAGS)[number] {
  return (BOOLEAN_FLAGS as readonly string[]).includes(name);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = {
    help: false,
    json: false,
    version: false,
    wait: false,
  };
  const positional: string[] = [];
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (onlyPositional || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositional = true;
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new UsageError(`Unknown option "${arg}".`);
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    if (isBooleanFlag(name)) {
      if (inlineValue !== null) {
        throw new UsageError(`--${name} does not take a value.`);
      }
      flags[name] = true;
      continue;
    }

    if (!isValueFlag(name)) {
      throw new UsageError(`Unknown option "--${name}".`);
    }

    if (inlineValue === null) {
      i += 1;
    }
    const value = inlineValue ?? argv[i];
    if (value === undefined || value === "") {
      throw new UsageError(`--${name} needs a value.`);
    }
    flags[name] = value;
  }

  const [first] = positional;
  if (first !== undefined && !(COMMANDS as readonly string[]).includes(first)) {
    throw new UsageError(`Unknown command "${first}".`);
  }

  return {
    command: (first as Command | undefined) ?? null,
    flags,
    positional: positional.slice(1),
  };
}

export function waitTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) {
    return 15 * 60 * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError("--timeout takes a number of seconds.");
  }
  return seconds * 1000;
}
