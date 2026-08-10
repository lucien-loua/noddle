// Verifies Swarm deployment via the API, against a REAL VM.
//
// The central assertion: detecting a rollback. Phase 0 measured that
// `docker service update` returns 0 after canceling the switch — so a
// worker that trusts the exit code shows a green deployment while the old
// version is still serving. This test fails if we fall back into that trap.
//
//   node apps/worker/src/verify-swarm.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { routeLabels } from "@noddle/proxy-config";
import {
  connect,
  disconnect,
  dockerClient,
  type SshClient,
} from "@noddle/ssh-executor";
import {
  deployService,
  ensureOverlayNetwork,
  isDeployAccepted,
  removeService,
} from "#swarm";

const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const HEALTHY_A = process.env.IMG_A ?? "spike-app:1785648147";
const HEALTHY_B = process.env.IMG_B ?? "spike-app:1785647822";
const BROKEN = process.env.IMG_BAD ?? "spike-app:broken-1785598128";

const SERVICE = "noddle-verify-svc";
const NETWORK = "noddle-public";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  [31m✗[0m ${m}`);
};

// ── labels (pure) ───────────────────────────────────────────────────────────
{
  const withDomain = routeLabels({
    domain: "app.example.com",
    port: 3000,
    serviceName: SERVICE,
  });
  if (
    withDomain[`traefik.http.services.${SERVICE}.loadbalancer.server.port`] ===
    "3000"
  ) {
    ok("labels: loadbalancer.server.port present (required in Swarm)");
  } else {
    ko("labels: port missing");
  }

  const noDomain = routeLabels({ port: 3000, serviceName: SERVICE });
  if (noDomain["traefik.enable"] === "false") {
    ok("labels: no domain → traefik.enable=false, no catch-all route");
  } else {
    ko("labels: a service without a domain would be exposed");
  }
}

let client: SshClient | undefined;

try {
  client = await connect({
    host: HOST,
    privateKey: readFileSync(KEY, "utf8"),
    user: USER,
  });
  const docker = dockerClient(client);
  ok(`connected to ${USER}@${HOST}`);

  await removeService(docker, SERVICE);
  await ensureOverlayNetwork(docker, NETWORK);

  const base = {
    env: { APP_VERSION: "verify" },
    labels: routeLabels({ port: 3000, serviceName: SERVICE }),
    networkName: NETWORK,
    port: 3000,
    serviceName: SERVICE,
  };

  // ── 1. creation ────────────────────────────────────────────────────────────
  const created = await deployService(docker, { ...base, image: HEALTHY_A });
  if (created.created && isDeployAccepted(created.updateState)) {
    ok(`creation accepted (updateState=${created.updateState ?? "none"})`);
  } else {
    ko(`creation refused: ${created.updateState} ${created.updateMessage}`);
  }

  // ── 2. healthy update ──────────────────────────────────────────────────────
  const updated = await deployService(docker, { ...base, image: HEALTHY_B });
  if (
    !updated.created &&
    updated.updateState === "completed" &&
    updated.runningImage === HEALTHY_B
  ) {
    ok(`healthy update → completed, image ${updated.runningImage}`);
  } else {
    ko(
      `unexpected healthy update: ${updated.updateState} / ${updated.runningImage}`
    );
  }

  // ── 3. THE test: broken image, rollback detected ───────────────────────────
  console.log("    (deploying the broken image, ~60s health gate…)");
  const broken = await deployService(docker, { ...base, image: BROKEN });

  if (broken.updateState === "rollback_completed") {
    ok(
      "broken image → Swarm rolled back, and the API says so: rollback_completed"
    );
  } else {
    ko(`expected state rollback_completed, got ${broken.updateState}`);
  }

  if (isDeployAccepted(broken.updateState)) {
    ko(
      "DANGER: the deployment is considered accepted even though it was rolled back"
    );
  } else {
    ok(
      "isDeployAccepted refuses the rollback — no false green on the dashboard"
    );
  }

  if (broken.runningImage === HEALTHY_B) {
    ok(`the image served stayed the healthy one: ${broken.runningImage}`);
  } else {
    ko(`unexpected served image: ${broken.runningImage}`);
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (client) {
    try {
      await removeService(dockerClient(client), SERVICE);
    } catch {
      // best-effort cleanup
    }
    disconnect(client);
  }
}

console.log(`\n[1mpassed ${pass}, failed ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
