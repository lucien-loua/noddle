// Le flux SSE des logs de build.
//
// Trois sources, dans cet ordre, et c'est l'ordre qui compte :
//
//   1. déploiement TERMINÉ  → le fichier d'archive, puis on ferme
//   2. rattrapage           → le tampon Redis plafonné, pour ce qui a déjà
//                             défilé avant l'arrivée de ce spectateur
//   3. direct               → l'abonnement Redis
//
// Sans (2), ouvrir le dashboard au milieu d'un build de trois minutes affiche
// un écran vide jusqu'à la ligne suivante : le pub/sub Redis est du
// fire-and-forget, il ne rejoue rien.

import { deployments } from "@noddle/db/schema";
import { isTerminalStatus, type LogMessage } from "@noddle/shared/logs";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { readArchive } from "@/lib/log-archive.server";
import { logHub } from "@/lib/redis.server";

/** Les proxys coupent une connexion inactive. Un build peut rester silencieux
 *  plusieurs minutes pendant une étape lente. */
const HEARTBEAT_MS = 25_000;

const UUID = /^[0-9a-f-]{36}$/i;

export const Route = createFileRoute("/api/logs/$deploymentId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // Les logs de build contiennent des URL de dépôt et des messages de
        // commit. Ce flux se garde comme le reste.
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("non authentifié", { status: 401 });
        }

        const { deploymentId } = params;
        if (!UUID.test(deploymentId)) {
          return new Response("identifiant invalide", { status: 400 });
        }

        const deployment = await db.query.deployments.findFirst({
          where: eq(deployments.id, deploymentId),
        });
        if (!deployment) {
          return new Response("déploiement introuvable", { status: 404 });
        }

        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            let unsubscribe: (() => void) | undefined;

            const finish = () => {
              if (closed) {
                return;
              }
              closed = true;
              if (heartbeat) {
                clearInterval(heartbeat);
              }
              unsubscribe?.();
              try {
                controller.close();
              } catch {
                // déjà fermé par le client
              }
            };

            const send = (message: LogMessage) => {
              if (closed) {
                return;
              }
              try {
                controller.enqueue(
                  encoder.encode(
                    `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`
                  )
                );
              } catch {
                finish();
              }
            };

            // Le client est parti : fermer l'abonnement Redis tout de suite,
            // sinon chaque onglet refermé laisse un écouteur derrière lui.
            request.signal.addEventListener("abort", finish);

            // 1. Terminé : l'archive suffit, il n'y aura plus rien en direct.
            if (isTerminalStatus(deployment.status)) {
              const archive = await readArchive(deploymentId);
              send({
                data: archive ?? "(aucun log conservé pour ce déploiement)\n",
                type: "chunk",
              });
              send({ status: deployment.status, type: "end" });
              finish();
              return;
            }

            // 3 avant 2 : on s'abonne AVANT de lire le rattrapage.
            //
            // Il y a forcément une fenêtre entre les deux, et il faut choisir
            // ce qu'elle produit. Dans cet ordre, une ligne publiée pendant la
            // fenêtre est vue DEUX fois — une par l'abonnement, une par le
            // tampon. Dans l'autre, elle est PERDUE : trop tard pour le tampon
            // déjà lu, trop tôt pour l'abonnement pas encore actif.
            //
            // Une ligne en double est cosmétique ; une ligne perdue dans la
            // sortie d'un build raté est ce qu'on cherchait précisément à
            // lire. Dédupliquer proprement demanderait un numéro de séquence
            // par ligne, donc une commande Redis de plus à chaque chunk — pas
            // le prix d'un doublon rare de quelques millisecondes.
            unsubscribe = await logHub.subscribe(deploymentId, (message) => {
              send(message);
              if (message.type === "end") {
                finish();
              }
            });

            for (const message of await logHub.backlog(deploymentId)) {
              send(message);
            }

            heartbeat = setInterval(() => {
              if (closed) {
                return;
              }
              try {
                // Un commentaire SSE : ignoré par EventSource, suffisant pour
                // que la connexion reste vivante.
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                finish();
              }
            }, HEARTBEAT_MS);
          },
        });

        return new Response(stream, {
          headers: {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            // Sans ça, un nginx en façade tamponne le flux et le direct
            // arrive par blocs de plusieurs kilo-octets.
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
