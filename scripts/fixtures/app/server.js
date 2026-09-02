// The spike's witness application. Its behaviour is driven by mode.txt, written
// into the source just before the build — so each mode produces a genuinely
// different IMAGE, not just an environment variable. That is what we want: a
// bad deploy is a bad image.
//
//   healthy         answers 200
//   unhealthy       answers 500 → the healthcheck never passes → Swarm rollback
//   crash:<sec>     answers 200, passes the healthcheck, then dies after <sec>
//
// The `crash` mode is the edge case CLAUDE.md describes: the container passes
// its healthcheck AND THEN dies. That is precisely what hand-rolled
// stop-then-start logic misses every time.
//
// The DELAY is the real parameter. It decides which side of Swarm's
// `--update-monitor` window the crash lands on:
//
//   crash BEFORE the monitor ends  → Swarm counts the failure and ROLLS BACK to
//                                    the healthy version. Measured: 25 s /
//                                    monitor 45 s.
//   crash AFTER the monitor ends   → the update is already reported successful,
//                                    the previous task has drained, there is
//                                    nothing left to restore. The restart policy
//                                    relaunches the broken image → crash loop.
//
// The second case is the one real users hit: an app that dies under load after
// a few minutes, not in 25 seconds.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.PORT) || 3000;
const fixtureDir = import.meta.dirname;

let raw = "healthy";
try {
  raw =
    fs.readFileSync(path.join(fixtureDir, "mode.txt"), "utf-8").trim() ||
    "healthy";
} catch {
  // no mode.txt → healthy
}

const [mode, crashArg] = raw.split(":");
const crashAfterMs = (Number(crashArg) || 25) * 1000;

// Injected at build time so two images can be told apart from the HTTP
// response. That is how the rollback test proves it really is the PREVIOUS
// version still serving.
const version = process.env.APP_VERSION || "dev";

if (mode === "crash") {
  setTimeout(() => {
    console.error(
      `[spike] simulated crash after ${crashAfterMs / 1000}s (healthcheck passed)`
    );
    process.exit(1);
  }, crashAfterMs);
}

http
  .createServer((_req, res) => {
    if (mode === "unhealthy") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("unhealthy\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`noddle-spike mode=${mode} version=${version}\n`);
  })
  .listen(port, () =>
    console.log(`[spike] listening on ${port} mode=${mode} version=${version}`)
  );
