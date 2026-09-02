// tier: pure
import type { LogEntry } from "@noddle/shared/logs";
import { check, runVerify, suite } from "@noddle/testing";

import { parseLastEventId, planReplay } from "./lib/log-replay";

const CAPACITY = 4;

function entry(seq: number, data: string): LogEntry {
  return { message: { data, type: "chunk" }, seq };
}

const buffered = [entry(1, "a"), entry(2, "b"), entry(3, "c")];

function texts(entries: LogEntry[]): string {
  return entries
    .map((item) => (item.message.type === "chunk" ? item.message.data : "end"))
    .join("");
}

await runVerify("log replay", async () => {
  await suite("a fresh viewer gets a snapshot", () => {
    const plan = planReplay(buffered, null, CAPACITY);

    check("it is announced as a reset", plan.reset);
    check("it carries the whole buffer", texts(plan.entries) === "abc");
    check("nothing is reported as omitted", plan.truncated === false);
  });

  await suite("a reconnecting viewer resumes where it stopped", () => {
    const plan = planReplay(buffered, 2, CAPACITY);

    check("its buffer is kept", plan.reset === false);
    check("only the missed tail is replayed", texts(plan.entries) === "c");
  });

  await suite("a viewer that is already up to date gets nothing", () => {
    const plan = planReplay(buffered, 3, CAPACITY);

    check("its buffer is kept", plan.reset === false);
    check("no entry is replayed", plan.entries.length === 0);
  });

  await suite("a gap in the sequence forces a snapshot", () => {
    const trimmed = [entry(8, "h"), entry(9, "i")];
    const plan = planReplay(trimmed, 2, CAPACITY);

    check("the viewer is told to reset", plan.reset);
    check("everything still held is replayed", texts(plan.entries) === "hi");
  });

  await suite("a buffer at capacity says so", () => {
    const full = [entry(1, "a"), entry(2, "b"), entry(3, "c"), entry(4, "d")];
    const plan = planReplay(full, null, CAPACITY);

    check("the omission is reported", plan.truncated);
  });

  await suite("an unnumbered buffer is never resumed against", () => {
    const legacy = [entry(0, "a"), entry(0, "b")];
    const plan = planReplay(legacy, 1, CAPACITY);

    check("the viewer is told to reset", plan.reset);
    check("the whole buffer is replayed", texts(plan.entries) === "ab");
  });

  await suite("an empty buffer cannot be resumed against", () => {
    const plan = planReplay([], 5, CAPACITY);

    check("the viewer is told to reset", plan.reset);
    check("nothing is replayed", plan.entries.length === 0);
  });

  await suite("the event id is read strictly", () => {
    check("a missing header is no resume", parseLastEventId(null) === null);
    check("a number is a resume point", parseLastEventId("42") === 42);
    check("zero is not a resume point", parseLastEventId("0") === null);
    check("junk is refused", parseLastEventId("12a") === null);
    check("a negative id is refused", parseLastEventId("-3") === null);
  });
});
