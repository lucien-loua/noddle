// Application témoin du spike. Son comportement est piloté par mode.txt, écrit
// dans la source juste avant le build — donc chaque mode produit une IMAGE
// réellement différente, pas juste une variable d'environnement. C'est ce qu'on
// veut : un mauvais déploiement, c'est une mauvaise image.
//
//   healthy         répond 200
//   unhealthy       répond 500 → le healthcheck ne passe jamais → Swarm rollback
//   crash:<sec>     répond 200, passe le healthcheck, puis meurt après <sec>
//
// Le mode `crash` est le cas limite cité dans CLAUDE.md : le conteneur passe son
// healthcheck PUIS meurt. C'est précisément ce que la logique stop-then-start
// écrite à la main rate systématiquement.
//
// Le DÉLAI est le vrai paramètre. Il décide de quel côté de la fenêtre
// `--update-monitor` de Swarm le crash tombe :
//
//   crash AVANT la fin du monitor  → Swarm compte l'échec et ROLLBACK vers la
//                                    version saine. Mesuré : 25 s / monitor 45 s.
//   crash APRÈS la fin du monitor  → l'update est déjà déclaré réussi, l'ancienne
//                                    task est drainée, il n'y a plus rien à
//                                    restaurer. La restart policy relance
//                                    l'image cassée → boucle de crash.
//
// Le second cas est celui que les vrais utilisateurs rencontrent : une app qui
// meurt sous charge après quelques minutes, pas en 25 secondes.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT) || 3000;

let raw = "healthy";
try {
  raw =
    fs
      .readFileSync(path.join(__dirname, "mode.txt"), "utf8")
      .trim() || "healthy";
} catch {
  // pas de mode.txt → healthy
}

const [mode, crashArg] = raw.split(":");
const crashAfterMs = (Number(crashArg) || 25) * 1000;

// Injecté au build pour qu'on puisse distinguer deux images en regardant la
// réponse HTTP. C'est comme ça que le test de rollback prouve que c'est bien
// l'ANCIENNE version qui sert encore.
const version = process.env.APP_VERSION || "dev";

if (mode === "crash") {
  setTimeout(() => {
    console.error(
      `[spike] crash simulé après ${crashAfterMs / 1000}s (healthcheck réussi)`
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
