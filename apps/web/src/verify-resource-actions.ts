// tier: pure
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

import {
  actionsFor,
  AWAITING_TIMEOUT_MS,
  isSettled,
  key,
  PENDING_LABEL,
  pollInterval,
  refine,
  statusOf,
  withMark,
  withoutMark,
} from "@/lib/resource-actions/core";
import type { PendingEntry } from "@/lib/resource-actions/core";
import type { ResourceRow } from "@/lib/scope-rows";

const WEB_SRC = join(import.meta.dirname);

function listSourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "resource-actions") {
      continue;
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full, rel));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.startsWith("verify")
    ) {
      out.push(rel);
    }
  }
  return out;
}

const row = (over: Partial<ResourceRow> = {}): ResourceRow => ({
  id: "r-1",
  inFlightDeployment: null,
  kind: "service",
  label: "app",
  name: "app",
  serverName: "vps-1",
  status: "running",
  updatedAt: "T1",
  ...over,
});

const NOW = 1_000_000;

const entry = (
  action: PendingEntry["action"],
  status: string,
  updatedAt: string,
  since = NOW
): PendingEntry => ({ action, since, status, updatedAt });

await runVerify("resource-actions core (C1)", () => {
  // --- isSettled: the pending-action window ---
  check(
    "stop settles once status changed",
    isSettled(
      { status: "stopped", updatedAt: "T1" },
      entry("stop", "running", "T1"),
      NOW
    )
  );
  check(
    "stop stays pending while status is unchanged",
    !isSettled(
      { status: "running", updatedAt: "T2" },
      entry("stop", "running", "T1"),
      NOW
    )
  );
  check(
    "restart settles on updatedAt, even with status unchanged",
    isSettled(
      { status: "running", updatedAt: "T2" },
      entry("restart", "running", "T1"),
      NOW
    )
  );
  check(
    "restart stays pending while updatedAt is unchanged",
    !isSettled(
      { status: "running", updatedAt: "T1" },
      entry("restart", "running", "T1"),
      NOW
    )
  );
  check(
    "a vanished row counts as settled",
    isSettled(undefined, entry("delete", "running", "T1"), NOW)
  );
  const fired = entry("stop", "running", "T1", NOW);
  check(
    "the 60s ceiling holds regardless of status, just before it",
    !isSettled(
      { status: "running", updatedAt: "T1" },
      fired,
      NOW + AWAITING_TIMEOUT_MS - 1
    )
  );
  check(
    "the 60s ceiling fires unconditionally, just after it",
    isSettled(
      { status: "running", updatedAt: "T1" },
      fired,
      NOW + AWAITING_TIMEOUT_MS + 1
    )
  );

  // --- refine: sweeping the pending map against live rows ---
  const rows = new Map([
    [key("service", "svc-1"), { status: "stopped", updatedAt: "T2" }],
    [key("service", "svc-2"), { status: "running", updatedAt: "T1" }],
  ]);
  const pending = new Map([
    [key("service", "svc-1"), entry("stop", "running", "T1")],
    [key("service", "svc-2"), entry("restart", "running", "T1")],
  ]);
  const refined = refine(rows, pending, NOW);
  check(
    "refine drops the settled entry",
    !refined.has(key("service", "svc-1"))
  );
  check(
    "refine keeps the still-pending entry",
    refined.has(key("service", "svc-2"))
  );
  const empty = new Map<string, PendingEntry>();
  check(
    "refine returns the same reference when pending is empty",
    refine(rows, empty, NOW) === empty
  );
  const stillPending = new Map([
    [key("service", "svc-2"), entry("restart", "running", "T1")],
  ]);
  check(
    "refine returns the same reference when nothing settles",
    refine(rows, stillPending, NOW) === stillPending
  );

  // --- withMark / withoutMark ---
  const marked = withMark(
    new Map(),
    "service:svc-1",
    entry("start", "stopped", "T1")
  );
  check("withMark adds the entry", marked.has("service:svc-1"));
  const unmarked = withoutMark(marked, "service:svc-1");
  check("withoutMark removes it", !unmarked.has("service:svc-1"));
  check(
    "withoutMark on an absent key returns the same map",
    withoutMark(marked, "service:nope") === marked
  );

  // --- one label map, and it is the only one ---
  check("restart reads Restarting", PENDING_LABEL.restart === "Restarting");
  check("stop reads Stopping", PENDING_LABEL.stop === "Stopping");
  check("delete reads Deleting", PENDING_LABEL.delete === "Deleting");

  // --- statusOf: pending, then in-flight deployment, then row status ---
  const pendingOnly = new Map([
    [key("service", "svc-1"), entry("stop", "running", "T1")],
  ]);
  check(
    "a pending action wins over everything else",
    statusOf(
      row({ id: "svc-1", inFlightDeployment: "building", status: "running" }),
      pendingOnly.get("service:svc-1")
    ).label === "Stopping"
  );
  check(
    "an in-flight deployment wins over the row's own status",
    statusOf(
      row({ inFlightDeployment: "building", status: "running" }),
      undefined
    ).tone === "busy"
  );
  check(
    "with neither, the row's own status resolves",
    statusOf(row({ inFlightDeployment: null, status: "crashed" }), undefined)
      .tone === "danger"
  );

  // --- actionsFor: which of the five actions apply to which kind ---
  const allowed = { delete: true, deploy: true, operate: true };
  check(
    "a stopped, permitted service offers start and delete, not restart",
    (() => {
      const set = actionsFor("service", "stopped", allowed);
      return set.has("start") && !set.has("restart") && set.has("delete");
    })()
  );
  check(
    "a running, permitted service offers stop, restart, deploy and delete",
    (() => {
      const set = actionsFor("service", "running", allowed);
      return (
        set.has("stop") &&
        set.has("restart") &&
        set.has("deploy") &&
        set.has("delete")
      );
    })()
  );
  check(
    "a never-deployed service offers deploy and delete, no lifecycle actions",
    (() => {
      const set = actionsFor("service", "created", allowed);
      return (
        set.has("deploy") &&
        set.has("delete") &&
        !(set.has("start") || set.has("stop") || set.has("restart"))
      );
    })()
  );
  check(
    "a stack never offers start, stop or restart",
    (() => {
      const set = actionsFor("stack", "running", allowed);
      return !(set.has("start") || set.has("stop") || set.has("restart"));
    })()
  );
  check(
    "a stack offers deploy and delete",
    (() => {
      const set = actionsFor("stack", "running", allowed);
      return set.has("deploy") && set.has("delete");
    })()
  );
  check(
    "deploy is withheld while a resource is being deleted",
    !actionsFor("service", "deleting", allowed).has("deploy")
  );
  check(
    "deploy stays available while mid-deploy, to allow superseding it",
    actionsFor("service", "deploying", allowed).has("deploy")
  );
  check(
    "a database never offers deploy",
    !actionsFor("database", "running", allowed).has("deploy")
  );
  check(
    "a database's lifecycle actions gate on operate, not deploy",
    actionsFor("database", "running", {
      ...allowed,
      deploy: false,
      operate: true,
    }).has("stop")
  );
  check(
    "a service's lifecycle actions gate on deploy, not operate",
    actionsFor("service", "running", {
      ...allowed,
      deploy: true,
      operate: false,
    }).has("stop")
  );
  check(
    "no permission means no actions at all",
    actionsFor("service", "running", {
      delete: false,
      deploy: false,
      operate: false,
    }).size === 0
  );

  // --- pollInterval: pending OR a transient status among the rows ---
  check(
    "no pending, no transient status: no poll",
    pollInterval([row({ status: "running" })], new Map(), 2000) === false
  );
  check(
    "a pending entry forces a poll even if every row looks settled",
    pollInterval([row({ status: "running" })], pendingOnly, 2000) === 2000
  );
  check(
    "a transient row status forces a poll with nothing pending",
    pollInterval([row({ status: "deploying" })], new Map(), 2000) === 2000
  );
  check(
    "a single row IS the scope for a detail route — its own transient status is enough",
    pollInterval([row({ status: "deleting" })], new Map(), 2000) === 2000
  );

  // --- the module is the only reader of its own internals ---
  const offenders = listSourceFiles(WEB_SRC).filter((file) => {
    const source = readFileSync(join(WEB_SRC, file), "utf-8");
    return (
      source.includes("resource-actions/core") ||
      source.includes("resource-actions/dispatch")
    );
  });
  check(
    "nothing outside lib/resource-actions imports its internals directly",
    offenders.length === 0,
    offenders.join(", ")
  );
});
