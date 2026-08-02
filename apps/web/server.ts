// Serveur de production du dashboard.
//
// `vite build` produit un gestionnaire `fetch` standard et les fichiers
// statiques, mais aucun serveur pour les servir. L'adaptateur officiel qui
// s'en charge (nitro) est en beta ; le web tourne déjà sur Bun, dont le
// serveur HTTP est natif et stable. Douze lignes ici valent mieux qu'une
// dépendance beta dans le chemin de démarrage de chaque installation.
//
//   bun run build && bun run start
import handler from "./dist/server/server.js";

const CLIENT_DIR = `${import.meta.dir}/dist/client`;
const port = Number(process.env.PORT ?? 3000);

// Vite empreinte les noms des fichiers de /assets/ : leur contenu ne change
// jamais sans que le nom change. Tout le reste (favicon, robots) peut être
// remplacé en place, donc pas d'immutable dessus.
const IMMUTABLE = "public, max-age=31536000, immutable";

Bun.serve({
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname !== "/") {
      const file = Bun.file(CLIENT_DIR + pathname);
      if (await file.exists()) {
        return new Response(file, {
          headers: pathname.startsWith("/assets/")
            ? { "Cache-Control": IMMUTABLE }
            : {},
        });
      }
    }

    return await handler.fetch(request);
  },
  // Un déploiement dure des minutes, mais le flux SSE des logs reste ouvert
  // tout du long. Sans ça, Bun coupe la connexion au bout de 10 s d'inactivité
  // et le tail se reconnecte en boucle.
  idleTimeout: 0,
  port,
});

process.stdout.write(`dashboard noddle sur http://0.0.0.0:${port}\n`);
