// Vérifie le moteur de build contre une VRAIE VM.
//
// L'assertion centrale n'est pas « le build réussit » mais « le plafond est
// réellement posé sur le builder ». En Phase 0, un plafond inopérant laissait
// les builds réussir : la protection paraissait active alors qu'elle n'existait
// pas. On inspecte donc le cgroup du conteneur buildkitd, pas la sortie de la
// commande.
//
//   node packages/build-engine/src/verify.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  connect,
  disconnect,
  exec,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import {
  BuildError,
  buildImage,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "./index.ts";

const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const BUILDER = "noddle-verify-builder";
const WORK = "/opt/noddle-verify";
const TAG = `noddle-verify:${Date.now()}`;

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

// ── 1. dimensionnement (pur) ────────────────────────────────────────────────
{
  const tiny = computeBuildCap({ totalMemoryMb: 1024 });
  const vps = computeBuildCap({ totalMemoryMb: 2048 });
  const big = computeBuildCap({ totalMemoryMb: 16_384 });

  if (tiny.memory === "512m") {
    ok("machine minuscule → plancher à 512m (un build Node échoue en dessous)");
  } else {
    ko(`plancher non respecté : ${tiny.memory}`);
  }
  if (Number.parseInt(vps.memory, 10) < 2048 - 768) {
    ok(`VPS 2 Go → ${vps.memory}, la place du plan de contrôle est réservée`);
  } else {
    ko(`plafond trop haut pour 2 Go : ${vps.memory}`);
  }
  if (Number.parseInt(big.memory, 10) > Number.parseInt(vps.memory, 10)) {
    ok(`16 Go → ${big.memory}, le plafond suit la machine`);
  } else {
    ko("le plafond ne suit pas la taille de la machine");
  }
}

let client: SshClient | undefined;

try {
  client = await connect({
    host: HOST,
    privateKey: readFileSync(KEY, "utf8"),
    user: USER,
  });
  ok(`connecté à ${USER}@${HOST}`);

  // ── 2. plafond réellement appliqué au builder ─────────────────────────────
  const cap = computeBuildCap({ totalMemoryMb: 2048 });
  await exec(client, `sudo docker buildx rm ${quoteArg(BUILDER)} 2>/dev/null`);
  await ensureCappedBuilder(client, BUILDER, cap);
  ok(`builder créé (${cap.memory}, quota ${cap.cpuQuota}/${cap.cpuPeriod})`);

  // LA vérification. On lit le cgroup du conteneur buildkitd, pas ce que la
  // commande prétend avoir fait.
  const inspect = await exec(
    client,
    `sudo docker inspect buildx_buildkit_${BUILDER}0 --format '{{.HostConfig.Memory}} {{.HostConfig.CPUQuota}}'`
  );
  const [memBytes, quota] = inspect.stdout.trim().split(" ").map(Number);
  const expectedBytes = Number.parseInt(cap.memory, 10) * 1024 * 1024;

  if (memBytes === expectedBytes) {
    ok(`cgroup mémoire posé pour de vrai : ${memBytes} octets`);
  } else {
    ko(`cgroup mémoire absent ou faux : ${memBytes}, attendu ${expectedBytes}`);
  }
  if (quota === cap.cpuQuota) {
    ok(`cgroup CPU posé pour de vrai : ${quota}`);
  } else {
    ko(`cgroup CPU absent ou faux : ${quota}, attendu ${cap.cpuQuota}`);
  }

  // ── 2bis. injection d'ARGUMENT (distincte de l'injection shell) ───────────
  // quoteArg neutralise les métacaractères du shell, PAS les valeurs qui
  // commencent par un tiret : git les lit comme des drapeaux, et
  // --upload-pack exécute une commande arbitraire. Aucun guillemet n'aide.
  const attacks: [string, Record<string, string>][] = [
    ["branche --upload-pack", { branch: "--upload-pack=/tmp/pwn.sh" }],
    ["URL --upload-pack", { repoUrl: "--upload-pack=/tmp/pwn.sh" }],
    ["URL -u", { repoUrl: "-u/tmp/pwn.sh" }],
    ["SHA drapeau", { commitSha: "--upload-pack=/tmp/pwn.sh" }],
  ];
  for (const [label, override] of attacks) {
    try {
      await fetchSource(client, {
        repoUrl: "https://example.com/x.git",
        branch: "main",
        dir: `${WORK}/attack`,
        ...override,
      });
      ko(`${label} — AURAIT DÛ ÊTRE REFUSÉ`);
    } catch (e) {
      if (e instanceof BuildError && e.stage === "validation") {
        ok(`${label} refusé avant toute exécution`);
      } else {
        ko(`${label} — mauvaise erreur : ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ── 3. récupération du code, avec le SHA en retour ────────────────────────
  const origin = `${WORK}/origin`;
  await exec(
    client,
    `sudo rm -rf ${quoteArg(WORK)} && sudo mkdir -p ${quoteArg(origin)} && sudo chown -R "$USER" ${quoteArg(WORK)} && ` +
      `cd ${quoteArg(origin)} && ` +
      `printf '{"name":"v","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf 'require("http").createServer((q,r)=>r.end("ok")).listen(3000)' > s.js && ` +
      "git init -q . && git config user.email v@x && git config user.name v && " +
      "git add -A && git commit -q -m init"
  );

  const sha = await fetchSource(client, {
    branch: "master",
    dir: `${WORK}/src`,
    repoUrl: `file://${origin}`,
  });
  if (/^[0-9a-f]{40}$/.test(sha)) {
    ok(`fetchSource renvoie un SHA complet : ${sha.slice(0, 8)}`);
  } else {
    ko(`SHA inattendu : ${sha}`);
  }

  // ── 4. build de bout en bout ──────────────────────────────────────────────
  let lines = 0;
  await buildImage(client, {
    builderName: BUILDER,
    dir: `${WORK}/src`,
    imageTag: TAG,
    onStderr: () => {
      lines += 1;
    },
    onStdout: () => {
      lines += 1;
    },
  });
  ok(`build réussi, ${lines} fragment(s) de log streamés`);

  const imgs = await exec(
    client,
    `sudo docker image inspect ${quoteArg(TAG)} --format '{{.Id}}'`
  );
  if (imgs.code === 0 && imgs.stdout.trim().startsWith("sha256:")) {
    ok("l'image existe dans le store Docker local");
  } else {
    ko("image introuvable après le build");
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (client) {
    await exec(
      client,
      `sudo docker buildx rm ${quoteArg(BUILDER)} 2>/dev/null`
    );
    await exec(client, `sudo docker image rm -f ${quoteArg(TAG)} 2>/dev/null`);
    await exec(client, `sudo rm -rf ${quoteArg(WORK)}`);
    disconnect(client);
  }
}

console.log(`\n[1mréussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
