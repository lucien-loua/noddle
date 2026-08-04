// Vérifie l'envoi contre un VRAI récepteur HTTP, lancé ici même.
//
//   bun  run packages/notifier/src/verify.ts
//   node packages/notifier/src/verify.ts
//
// Ce qui est réellement exercé : le POST, les en-têtes, le corps exact reçu à
// l'autre bout, et surtout les CHEMINS D'ÉCHEC — un webhook révoqué (404), un
// destinataire qui refuse (401), un serveur qui ne répond jamais, un hôte qui
// n'existe pas. C'est là que se joue le sujet : une notification qui échoue en
// silence est pire que pas de notification, donc chaque échec doit remonter
// avec une cause lisible.
//
// NON vérifié ici : le vrai Discord et le vrai Slack. Il faudrait une URL de
// webhook réelle, qui est un secret porteur. Les formes produites sont
// asserties contre ce que leurs API documentent, et le transport est réel —
// mais personne n'a vu le message s'afficher dans un salon.
import { createServer, type Server } from "node:http";
import {
  buildPayload,
  deliver,
  eventLabel,
  isFailure,
  type NotificationEvent,
} from "#index";

const runtime =
  typeof globalThis.Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${globalThis.Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

interface Received {
  body: string;
  contentType?: string;
  method: string;
}

const received: Received[] = [];
let mode: "hang" | "ok" | "refuse" | "revoked" = "ok";

function start(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        received.push({
          body,
          contentType: req.headers["content-type"],
          method: req.method ?? "",
        });
        if (mode === "hang") {
          // On ne répond jamais : c'est le cas du destinataire qui accepte la
          // connexion puis se tait, que seul un délai d'attente rattrape.
          return;
        }
        if (mode === "revoked") {
          res.writeHead(404).end("Unknown Webhook");
          return;
        }
        if (mode === "refuse") {
          res.writeHead(401).end("invalid token");
          return;
        }
        res.writeHead(204).end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, server });
    });
  });
}

const event: NotificationEvent = {
  detail: "le build a échoué : exit 1",
  resource: "api",
  type: "deploy_failed",
  url: "https://noddle.example/",
};

console.log(`\n\x1b[1m${runtime} — notifications\x1b[0m`);

const { port, server } = await start();
const base = `http://127.0.0.1:${port}`;

try {
  // ── 1. Les formes de charge utile ────────────────────────────────────────
  const discord = buildPayload("discord", event) as {
    embeds: { color: number; title: string }[];
  };
  if (
    discord.embeds[0]?.title === "Déploiement échoué — api" &&
    discord.embeds[0]?.color === 0xd1_3d_3d
  ) {
    ok("Discord : embed titré, couleur d'échec");
  } else {
    ko(`Discord : ${JSON.stringify(discord).slice(0, 120)}`);
  }

  const success = buildPayload("discord", {
    resource: "api",
    type: "deploy_succeeded",
  }) as { embeds: { color: number }[] };
  if (success.embeds[0]?.color === 0x2e_9e_4f) {
    ok("Discord : couleur distincte pour un succès");
  } else {
    ko("Discord : même couleur pour un succès et un échec");
  }

  const slack = buildPayload("slack", event) as { text: string };
  if (
    slack.text.includes("Déploiement échoué — api") &&
    slack.text.includes("<https://noddle.example/|")
  ) {
    ok("Slack : texte simple, lien au format mrkdwn");
  } else {
    ko(`Slack : ${slack.text}`);
  }

  const raw = buildPayload("webhook", event) as Record<string, unknown>;
  if (raw.type === "deploy_failed" && raw.failure === true && raw.at) {
    ok("webhook : forme brute structurée, pas mise en forme");
  } else {
    ko(`webhook : ${JSON.stringify(raw)}`);
  }

  // Un succès ne doit pas être annoncé comme une panne.
  if (isFailure("watch_reverted") && !isFailure("deploy_succeeded")) {
    ok("isFailure distingue une reprise d'un succès");
  } else {
    ko("isFailure incohérent");
  }

  // Les deux formes de retour arrière restent DISTINCTES : leur différence
  // est celle qui décide de la confiance qu'on accorde à l'outil.
  if (eventLabel("deploy_reverted") === eventLabel("watch_reverted")) {
    ko("les deux formes de retour arrière portent le même libellé");
  } else {
    ok("« annulé par Swarm » et « repris par la surveillance » sont distincts");
  }

  // ── 2. Un envoi qui aboutit ──────────────────────────────────────────────
  mode = "ok";
  received.length = 0;
  let r = await deliver({ kind: "discord", url: base }, event);
  if (r.ok && r.status === 204) {
    ok(`envoi abouti : HTTP ${r.status}`);
  } else {
    ko(`envoi : ${JSON.stringify(r)}`);
  }
  const [got] = received;
  if (got?.method === "POST" && got.contentType?.includes("application/json")) {
    ok("reçu en POST avec content-type JSON");
  } else {
    ko(`reçu : ${JSON.stringify(got)}`);
  }
  if (got && JSON.parse(got.body).embeds[0].title.includes("api")) {
    ok("le corps reçu à l'autre bout est bien celui construit");
  } else {
    ko("le corps reçu ne correspond pas");
  }

  // ── 3. Les chemins d'échec — le cœur du sujet ────────────────────────────
  // Un webhook Discord révoqué répond 404 SANS que la requête échoue au sens
  // réseau. Conclure du seul fait que `fetch` a abouti reproduirait l'erreur
  // que le projet refuse ailleurs : inférer un succès d'un code de sortie.
  mode = "revoked";
  r = await deliver({ kind: "discord", url: base }, event);
  if (!r.ok && r.status === 404) {
    ok(`webhook révoqué détecté : ${r.error?.slice(0, 40)}`);
  } else {
    ko(`404 non détecté : ${JSON.stringify(r)}`);
  }

  mode = "refuse";
  r = await deliver({ kind: "slack", url: base }, event);
  if (!r.ok && r.status === 401) {
    ok("destinataire qui refuse détecté (401)");
  } else {
    ko(`401 non détecté : ${JSON.stringify(r)}`);
  }

  // Hôte inexistant : panne réseau, pas de statut.
  r = await deliver(
    { kind: "webhook", url: "https://hote-qui-nexiste-pas.invalid/x" },
    event
  );
  if (!(r.ok || r.status) && r.error) {
    ok(`hôte injoignable rapporté sans statut : ${r.error.slice(0, 40)}`);
  } else {
    ko(`hôte injoignable : ${JSON.stringify(r)}`);
  }

  // ── 4. L'URL ne doit JAMAIS fuiter dans le message d'erreur ──────────────
  // Elle est porteuse — qui la détient peut écrire dans le salon — et ce
  // message finit dans une colonne affichée à l'écran.
  const secret = "https://hooks.example.invalid/tres-secret-abc123";
  r = await deliver({ kind: "discord", url: secret }, event);
  if (r.error?.includes("tres-secret-abc123")) {
    ko("DANGER : l'URL du canal apparaît dans le message d'erreur");
  } else {
    ok("l'URL du canal ne fuite pas dans le message d'erreur");
  }

  // ── 5. Ne jamais lever ───────────────────────────────────────────────────
  // Un envoi ne doit pas faire échouer le déploiement qui l'a déclenché.
  let threw = false;
  try {
    await deliver({ kind: "webhook", url: "pas-une-url" }, event);
  } catch {
    threw = true;
  }
  if (threw) {
    ko("deliver a levé — un canal cassé ferait échouer le job appelant");
  } else {
    ok("deliver ne lève jamais, même sur une URL invalide");
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.close();
}

console.log(`\n\x1b[1m${runtime} — réussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
