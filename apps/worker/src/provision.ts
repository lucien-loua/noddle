// Provisionne un serveur ajouté depuis le tableau de bord.
//
// L'installateur fait tout ça pour la machine n°1 en shell local ; ici c'est
// la MÊME séquence, mais par SSH vers une machine qui n'a jamais vu Noddle :
// Docker, rejoindre le cluster Swarm en WORKER (jamais manager — voir
// swarm.ts et deploy.ts sur pourquoi un seul manager), nixpacks, puis les
// mêmes faits que `refreshServerFacts` relève déjà pour la machine n°1.
//
// « Ajouter un serveur = coller un hôte et une clé, rien d'autre » : c'est ce
// module qui rend cette promesse vraie. L'utilisateur ne SSH jamais lui-même
// dans la nouvelle machine.
import { servers } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import type { DeployContext } from "#deploy";

async function connectAsRow(
  ctx: DeployContext,
  row: typeof servers.$inferSelect
) {
  const privateKey = decryptSecret(
    row.sshPrivateKeyEncrypted,
    ctx.appKey,
    secretContext.serverSshKey(row.id)
  );
  return await connect({
    host: row.host,
    port: row.sshPort,
    privateKey,
    user: row.sshUser,
  });
}

async function markFailed(
  ctx: DeployContext,
  serverId: string,
  message: string
): Promise<void> {
  await ctx.db
    .update(servers)
    .set({ lastError: message, status: "unreachable" })
    .where(eq(servers.id, serverId));
}

export async function provisionServer(
  ctx: DeployContext,
  serverId: string
): Promise<void> {
  const server = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    throw new Error(`serveur introuvable : ${serverId}`);
  }

  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    await markFailed(
      ctx,
      serverId,
      "aucun manager Swarm enregistré — l'installateur a-t-il tourné ?"
    );
    throw new Error("aucun manager Swarm enregistré");
  }

  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let managerClient: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    client = await connectAsRow(ctx, server);

    // Idempotent, comme install.sh : `docker info` avant tout `swarm init`
    // ou `swarm join` évite de rejouer l'opération sur un nœud déjà membre.
    // JAMAIS `... | grep -q` — voir CLAUDE.md, la course au SIGPIPE sous
    // `pipefail` a déjà coûté un run de la Phase 0.
    const dockerCheck = await exec(client, "command -v docker");
    if (dockerCheck.code !== 0) {
      await exec(client, "curl -fsSL https://get.docker.com | sudo sh");
    }

    // L'utilisateur SSH DOIT appartenir au groupe `docker` : `dockerClient()`
    // ouvre le socket EN DIRECT, sans passer par un shell — donc sans
    // `sudo` possible sur une socket (voir l'en-tête de
    // @noddle/ssh-executor). `usermod -aG` est idempotent, sans risque à
    // rejouer même si déjà membre.
    //
    // Et l'appartenance à un groupe ne s'applique qu'à une NOUVELLE session :
    // la connexion SSH en cours ne la voit jamais, qu'on vienne d'installer
    // Docker ou non. Sans reconnexion ici, le premier appel `dockerClient()`
    // plus bas échoue avec « Channel open failure » — mesuré sur ce script,
    // contre une VM réellement nue.
    await execArgv(client, [
      "sudo",
      "usermod",
      "-aG",
      "docker",
      server.sshUser,
    ]);
    disconnect(client);
    client = await connectAsRow(ctx, server);

    const swarmState = await exec(
      client,
      "sudo docker info --format '{{.Swarm.LocalNodeState}}'"
    );

    if (swarmState.stdout.trim() !== "active") {
      managerClient = await connectAsRow(ctx, manager);
      const managerDocker = dockerClient(managerClient);
      // Le jeton WORKER, jamais le manager : ce nœud ne doit pouvoir ni créer
      // ni mettre à jour un service — `docker service create/update` exige un
      // manager, précisément parce que lui seul détient l'état répliqué du
      // cluster. Rester worker n'est pas une limitation qu'on accepte, c'est
      // la garantie que la taille du quorum Raft ne bouge pas quand on
      // ajoute un serveur.
      const swarmInfo = (await managerDocker.swarmInspect()) as {
        JoinTokens?: { Worker?: string };
      };
      const token = swarmInfo.JoinTokens?.Worker;
      if (!token) {
        throw new Error("jeton de jonction Swarm introuvable sur le manager");
      }

      // `execArgv`, pas `exec` : `token` et l'hôte du manager ne sont pas des
      // constantes du code, la convention de ssh-executor s'applique.
      const join = await execArgv(client, [
        "sudo",
        "docker",
        "swarm",
        "join",
        "--token",
        token,
        `${manager.host}:2377`,
      ]);
      if (join.code !== 0) {
        throw new Error(
          `échec de la jonction au cluster Swarm : ${join.stderr.trim() || join.stdout.trim()}`
        );
      }
    }

    const nixpacksCheck = await exec(client, "command -v nixpacks");
    if (nixpacksCheck.code !== 0) {
      await exec(
        client,
        "curl -sSL https://nixpacks.com/install.sh | sudo bash"
      );
    }

    // Les mêmes faits que la machine n°1, relevés en Phase 1.
    const docker = dockerClient(client);
    const info = (await docker.info()) as { MemTotal?: number };
    const version = (await docker.version()) as {
      MinAPIVersion?: string;
      Version?: string;
    };

    await ctx.db
      .update(servers)
      .set({
        dockerApiMinVersion: version.MinAPIVersion ?? null,
        dockerVersion: version.Version ?? null,
        lastError: null,
        status: "connected",
        totalMemoryMb: info.MemTotal
          ? Math.round(info.MemTotal / 1024 / 1024)
          : null,
      })
      .where(eq(servers.id, server.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(ctx, serverId, message);
    throw err;
  } finally {
    if (managerClient) {
      disconnect(managerClient);
    }
    if (client) {
      disconnect(client);
    }
  }
}
