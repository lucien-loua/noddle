// Puits de logs de déploiement.
//
// Deux destinations, une seule source : le flux part vers SSE pour le dashboard
// ET s'écrit sur disque pour l'historique.
//
// Ce qu'il ne fait PAS : une ligne Postgres par ligne de log. Un build Next.js
// en produit des dizaines de milliers ; la table `deployment_logs` ne stocke
// qu'un POINTEUR (storage_url, byte_size). Le stockage est un fichier local en
// Phase 1 — S3 reste possible sans migration puisque la colonne est une URL.
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface LogSink {
  /** Renvoie de quoi remplir `deployment_logs`. */
  close: () => Promise<{ storageUrl: string; byteSize: number }>;
  write: (chunk: string) => void;
}

export interface LogSinkOptions {
  deploymentId: string;
  /** Alimente le flux SSE. Doit rester non bloquant. */
  onChunk?: (chunk: string) => void;
  /** Racine de stockage. `/var/lib/noddle/logs` en production. */
  root: string;
}

export async function createLogSink(o: LogSinkOptions): Promise<LogSink> {
  const path = join(o.root, `${o.deploymentId}.log`);
  await mkdir(dirname(path), { recursive: true });

  const stream: WriteStream = createWriteStream(path, { flags: "a" });
  let bytes = 0;
  let closed = false;

  return {
    close() {
      closed = true;
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) =>
          err
            ? reject(err)
            : resolve({ byteSize: bytes, storageUrl: `file://${path}` })
        );
      });
    },
    write(chunk: string) {
      if (closed) {
        return;
      }
      bytes += Buffer.byteLength(chunk, "utf8");
      stream.write(chunk);
      // Le dashboard ne doit jamais faire tomber un déploiement. Si le flux SSE
      // est mort, le build continue.
      try {
        o.onChunk?.(chunk);
      } catch {
        // ignoré volontairement
      }
    },
  };
}
