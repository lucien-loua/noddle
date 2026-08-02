// Vérifie le déploiement Swarm par l'API, contre une VRAIE VM.
//
// L'assertion centrale : détecter un rollback. La Phase 0 a mesuré que
// `docker service update` renvoie 0 après avoir annulé la bascule — donc un
// worker qui se fie au code de sortie affiche un déploiement vert pendant que
// l'ancienne version sert. Ce test échoue si on retombe dans ce piège.
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
} from "./swarm.ts";

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

// ── labels (pur) ────────────────────────────────────────────────────────────
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
    ok("labels : loadbalancer.server.port présent (obligatoire en Swarm)");
  } else {
    ko("labels : port manquant");
  }

  const noDomain = routeLabels({ port: 3000, serviceName: SERVICE });
  if (noDomain["traefik.enable"] === "false") {
    ok(
      "labels : sans domaine → traefik.enable=false, pas de route fourre-tout"
    );
  } else {
    ko("labels : un service sans domaine serait exposé");
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
  ok(`connecté à ${USER}@${HOST}`);

  await removeService(docker, SERVICE);
  await ensureOverlayNetwork(docker, NETWORK);

  const base = {
    env: { APP_VERSION: "verify" },
    labels: routeLabels({ port: 3000, serviceName: SERVICE }),
    networkName: NETWORK,
    port: 3000,
    serviceName: SERVICE,
  };

  // ── 1. création ───────────────────────────────────────────────────────────
  const created = await deployService(docker, { ...base, image: HEALTHY_A });
  if (created.created && isDeployAccepted(created.updateState)) {
    ok(`création acceptée (updateState=${created.updateState ?? "aucun"})`);
  } else {
    ko(`création refusée : ${created.updateState} ${created.updateMessage}`);
  }

  // ── 2. mise à jour saine ──────────────────────────────────────────────────
  const updated = await deployService(docker, { ...base, image: HEALTHY_B });
  if (
    !updated.created &&
    updated.updateState === "completed" &&
    updated.runningImage === HEALTHY_B
  ) {
    ok(`mise à jour saine → completed, image ${updated.runningImage}`);
  } else {
    ko(
      `mise à jour saine inattendue : ${updated.updateState} / ${updated.runningImage}`
    );
  }

  // ── 3. LE test : image cassée, rollback détecté ───────────────────────────
  console.log("    (déploiement de l'image cassée, ~60 s de health gate…)");
  const broken = await deployService(docker, { ...base, image: BROKEN });

  if (broken.updateState === "rollback_completed") {
    ok("image cassée → Swarm a annulé, et l'API le dit : rollback_completed");
  } else {
    ko(`état attendu rollback_completed, obtenu ${broken.updateState}`);
  }

  if (isDeployAccepted(broken.updateState)) {
    ko(
      "DANGER : le déploiement est considéré comme accepté alors qu'il a été annulé"
    );
  } else {
    ok("isDeployAccepted refuse le rollback — pas de faux vert au dashboard");
  }

  if (broken.runningImage === HEALTHY_B) {
    ok(`l'image servie est restée la saine : ${broken.runningImage}`);
  } else {
    ko(`image servie inattendue : ${broken.runningImage}`);
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (client) {
    try {
      await removeService(dockerClient(client), SERVICE);
    } catch {
      // nettoyage au mieux
    }
    disconnect(client);
  }
}

console.log(`\n[1mréussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
