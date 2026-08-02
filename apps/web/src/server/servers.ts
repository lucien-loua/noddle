// Ajouter un serveur cible, et lister ceux déjà connus.
//
// « Ajouter un serveur = coller un hôte et une clé, rien d'autre. » Cette
// server function tient cette promesse : elle valide, chiffre, enregistre en
// attente, dépose un job — et le worker fait tout le reste par SSH
// (Docker, jonction Swarm en worker, nixpacks). Personne ne se connecte
// jamais à la main dans la nouvelle machine.
import { servers } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { serverInputSchema } from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

export interface ServerView {
  createdAt: string;
  dockerVersion: string | null;
  host: string;
  id: string;
  isSelf: boolean;
  lastError: string | null;
  name: string;
  role: "manager" | "worker";
  status: "connected" | "pending" | "unreachable";
  totalMemoryMb: number | null;
}

export const getServers = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerView[]> => {
    await requireSession();

    const rows = await db.query.servers.findMany({
      orderBy: desc(servers.isSelf),
    });

    // La clé chiffrée ne sort JAMAIS d'ici, même chiffrée : une server
    // function ne renvoie que ce que l'écran a besoin d'afficher.
    return rows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      dockerVersion: row.dockerVersion,
      host: row.host,
      id: row.id,
      isSelf: row.isSelf,
      lastError: row.lastError,
      name: row.name,
      role: row.role,
      status: row.status,
      totalMemoryMb: row.totalMemoryMb,
    }));
  }
);

export const addServer = createServerFn({ method: "POST" })
  .validator(serverInputSchema)
  .handler(async ({ data }): Promise<{ serverId: string }> => {
    await requireSession();

    // L'AAD lie le chiffré à la LIGNE : l'identifiant doit exister avant le
    // chiffrement, d'où l'insertion en deux temps — même schéma que
    // adopt-host.ts côté worker, pour la même raison.
    const [created] = await db
      .insert(servers)
      .values({
        host: data.host,
        name: data.name,
        sshPort: data.sshPort,
        sshPrivateKeyEncrypted: "placeholder",
        sshUser: data.sshUser,
      })
      .returning();
    if (!created) {
      throw new Error("enregistrement du serveur impossible");
    }

    await db
      .update(servers)
      .set({
        sshPrivateKeyEncrypted: encryptSecret(
          data.privateKey,
          env.appKey,
          secretContext.serverSshKey(created.id)
        ),
      })
      .where(eq(servers.id, created.id));

    // Le worker fait le reste : Docker si absent, jonction au cluster Swarm
    // EN WORKER (jamais manager — un second manager changerait la taille du
    // quorum Raft sans qu'on le demande), nixpacks, puis les mêmes faits que
    // la machine n°1.
    await enqueueDeploy({ kind: "provision-server", serverId: created.id });

    return { serverId: created.id };
  });
