// tier: pure
import { check, runVerify } from "@noddle/testing";

import { log } from "#log";

function captured(body: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

await runVerify("log (one JSON line, secrets redacted)", () => {
  const [line] = captured(() => log.write("ssh.connect", { server: "vps-1" }));
  check("a line is written", Boolean(line));
  check("it ends with a newline", line?.endsWith("\n") === true);

  const parsed = JSON.parse(line ?? "{}");
  check("the event is named", parsed.evt === "ssh.connect");
  check("the level defaults to info", parsed.lvl === "info");
  check("it carries a timestamp", typeof parsed.t === "string");
  check("caller fields survive", parsed.server === "vps-1");

  const [redacted] = captured(() =>
    log.write("db.connect", {
      url: "postgres://noddle:hunter2@db.internal:5432/noddle",
    })
  );
  const url = JSON.parse(redacted ?? "{}").url as string;
  check("a password in a URL never reaches the line", !url.includes("hunter2"));
  check("the rest of the URL survives", url.includes("db.internal:5432"));

  const [failure] = captured(() =>
    log.error("deploy.failed", new Error("connect ECONNREFUSED"), {
      deployment: "d_41",
    })
  );
  const parsedError = JSON.parse(failure ?? "{}");
  check("an error raises the level", parsedError.lvl === "error");
  check("the message is carried", parsedError.err === "connect ECONNREFUSED");
  check(
    "the stack is carried — the thing the worker used to drop",
    typeof parsedError.stack === "string" && parsedError.stack.length > 0
  );
  check("context survives beside the error", parsedError.deployment === "d_41");

  const [scoped] = captured(() =>
    log.scoped({ deployment: "d_41" }).write("build.started", { app: "web" })
  );
  const parsedScope = JSON.parse(scoped ?? "{}");
  check(
    "a scope is carried into every line",
    parsedScope.deployment === "d_41"
  );
  check("the call's own fields survive it", parsedScope.app === "web");

  const [undef] = captured(() =>
    log.write("noop", { kept: "yes", missing: undefined })
  );
  const parsedUndef = JSON.parse(undef ?? "{}");
  check("an undefined field is dropped", !("missing" in parsedUndef));
  check("a defined one beside it is kept", parsedUndef.kept === "yes");
});
