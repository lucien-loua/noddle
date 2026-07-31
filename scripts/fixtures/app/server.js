// Application témoin du spike. Son comportement est piloté par mode.txt, écrit
// dans la source juste avant le build — donc chaque mode produit une IMAGE
// réellement différente, pas juste une variable d'environnement. C'est ce qu'on
// veut : un mauvais déploiement, c'est une mauvaise image.
//
//   healthy    répond 200
//   unhealthy  répond 500 → le healthcheck ne passe jamais → Swarm rollback
//   crash      répond 200, passe le healthcheck, puis meurt 25 s plus tard
//
// Le mode `crash` est le cas limite cité dans CLAUDE.md : le conteneur passe son
// healthcheck PUIS meurt. C'est précisément ce que la logique stop-then-start
// écrite à la main rate systématiquement.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT) || 3000;

let mode = 'healthy';
try {
  mode = fs.readFileSync(path.join(__dirname, 'mode.txt'), 'utf8').trim() || 'healthy';
} catch {
  // pas de mode.txt → healthy
}

// Injecté au build pour qu'on puisse distinguer deux images en regardant la
// réponse HTTP. C'est comme ça que le test de rollback prouve que c'est bien
// l'ANCIENNE version qui sert encore.
const version = process.env.APP_VERSION || 'dev';

if (mode === 'crash') {
  setTimeout(() => {
    console.error('[spike] crash simulé après healthcheck réussi');
    process.exit(1);
  }, 25000);
}

http
  .createServer((_req, res) => {
    if (mode === 'unhealthy') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('unhealthy\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`noddle-spike mode=${mode} version=${version}\n`);
  })
  .listen(port, () => console.log(`[spike] listening on ${port} mode=${mode} version=${version}`));
