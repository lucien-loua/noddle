/**
 * Parse a pasted .env blob the way Vercel does: `KEY=value` lines become
 * rows. Comments, `export `, and quotes are stripped; a lone value without
 * `=` is left to the input.
 */

export interface EnvPair {
  key: string;
  value: string;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_BREAK = /\r?\n/;

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const start = raw.at(0);
    const end = raw.at(-1);
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseLine(raw: string): EnvPair | null {
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return null;
  }
  if (line.startsWith("export ")) {
    line = line.slice("export ".length).trim();
  }

  let key: string;
  let rest: string;

  const eq = line.indexOf("=");
  if (eq > 0) {
    key = line.slice(0, eq).trim();
    rest = line.slice(eq + 1);
  } else {
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      return null;
    }
    key = line.slice(0, tab).trim();
    rest = line.slice(tab + 1);
  }

  if (!KEY.test(key)) {
    return null;
  }

  let value = rest.trim();
  if (
    !(
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    const comment = value.indexOf(" #");
    if (comment >= 0) {
      value = value.slice(0, comment).trimEnd();
    }
  }

  return { key, value: unquote(value) };
}

export function parseEnvPaste(text: string): EnvPair[] {
  const pairs: EnvPair[] = [];
  const seen = new Set<string>();
  for (const line of text.split(LINE_BREAK)) {
    const pair = parseLine(line);
    if (!pair) {
      continue;
    }
    if (seen.has(pair.key)) {
      const index = pairs.findIndex((item) => item.key === pair.key);
      if (index >= 0) {
        pairs[index] = pair;
      }
      continue;
    }
    seen.add(pair.key);
    pairs.push(pair);
  }
  return pairs;
}

/**
 * Intercept the paste when it looks like a .env blob, not a single field.
 * A value that happens to contain `=` (a URL, a JWT) must still type in.
 */
export function shouldInterceptEnvPaste(
  text: string,
  field: "key" | "value",
  currentKey: string
): boolean {
  const pairs = parseEnvPaste(text);
  if (pairs.length === 0) {
    return false;
  }
  if (pairs.length > 1) {
    return true;
  }
  if (field === "key") {
    return text.includes("=") || text.includes("\t");
  }
  return currentKey.length === 0 && (text.includes("=") || text.includes("\t"));
}
