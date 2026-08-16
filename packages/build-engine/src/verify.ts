// tier: vm
// node packages/build-engine/src/verify.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  connect,
  disconnect,
  exec,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";

import {
  BUILDKIT_CONTAINER,
  BUILDX_BUILDER,
  BuildError,
  buildImage,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "#index";

const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const WORK = "/opt/noddle-verify";
const TAG = `noddle-verify:${Date.now()}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  [31m✗[0m ${m}`);
};

// ── 1. sizing (pure) ────────────────────────────────────────────────────────
{
  const tiny = computeBuildCap({ totalMemoryMb: 1024 });
  const vps = computeBuildCap({ totalMemoryMb: 2048 });
  const big = computeBuildCap({ totalMemoryMb: 16_384 });

  if (tiny.memory === "512m") {
    ok("tiny machine → floor at 512m (a Node build fails below that)");
  } else {
    ko(`floor not respected: ${tiny.memory}`);
  }
  if (Number.parseInt(vps.memory, 10) < 2048 - 768) {
    ok(`2 GB VPS → ${vps.memory}, control-plane room is reserved`);
  } else {
    ko(`cap too high for 2 GB: ${vps.memory}`);
  }
  if (Number.parseInt(big.memory, 10) > Number.parseInt(vps.memory, 10)) {
    ok(`16 GB → ${big.memory}, the cap follows the machine`);
  } else {
    ko("the cap does not follow machine size");
  }
}

let client: SshClient | undefined;

try {
  client = await connect({
    host: HOST,
    privateKey: readFileSync(KEY, "utf8"),
    user: USER,
  });
  ok(`connected to ${USER}@${HOST}`);

  // ── 2. cap actually applied to the builder ────────────────────────────────
  const cap = computeBuildCap({ totalMemoryMb: 2048 });
  await exec(
    client,
    `sudo docker buildx rm ${quoteArg(BUILDX_BUILDER)} 2>/dev/null`
  );
  await exec(
    client,
    `sudo docker rm -f ${quoteArg(BUILDKIT_CONTAINER)} 2>/dev/null`
  );
  await ensureCappedBuilder(client, cap);
  ok(`builder created (${cap.memory}, quota ${cap.cpuQuota}/${cap.cpuPeriod})`);

  // THE check. We read the buildkitd container's cgroup, not what the command
  // claims to have done.
  const inspect = await exec(
    client,
    `sudo docker inspect ${quoteArg(BUILDKIT_CONTAINER)} --format '{{.HostConfig.Memory}} {{.HostConfig.CpuQuota}}'`
  );
  const [memBytes, quota] = inspect.stdout.trim().split(" ").map(Number);
  const expectedBytes = Number.parseInt(cap.memory, 10) * 1024 * 1024;

  if (memBytes === expectedBytes) {
    ok(`memory cgroup actually set: ${memBytes} bytes`);
  } else {
    ko(
      `memory cgroup missing or wrong: ${memBytes}, expected ${expectedBytes}`
    );
  }
  if (quota === cap.cpuQuota) {
    ok(`CPU cgroup actually set: ${quota}`);
  } else {
    ko(`CPU cgroup missing or wrong: ${quota}, expected ${cap.cpuQuota}`);
  }

  // ── 2bis. ARGUMENT injection (distinct from shell injection) ──────────────
  // quoteArg neutralizes shell metacharacters, NOT values that start with a
  // dash: git reads them as flags, and --upload-pack executes an arbitrary
  // command. No amount of quoting helps.
  const attacks: [string, Record<string, string>][] = [
    ["branch --upload-pack", { branch: "--upload-pack=/tmp/pwn.sh" }],
    ["URL --upload-pack", { repoUrl: "--upload-pack=/tmp/pwn.sh" }],
    ["URL -u", { repoUrl: "-u/tmp/pwn.sh" }],
    ["SHA flag", { commitSha: "--upload-pack=/tmp/pwn.sh" }],
  ];
  // Run in parallel: validation rejects BEFORE any I/O, so nothing to
  // serialize — and a looped `await` would wait on each attempt for nothing.
  const attempts = await Promise.all(
    attacks.map(async ([label, override]) => {
      try {
        await fetchSource(client as SshClient, {
          branch: "main",
          dir: `${WORK}/attack`,
          repoUrl: "https://example.com/x.git",
          ...override,
        });
        return { label, outcome: "passed" as const };
      } catch (e) {
        return e instanceof BuildError && e.stage === "validation"
          ? { label, outcome: "blocked" as const }
          : {
              detail: e instanceof Error ? e.message : String(e),
              label,
              outcome: "error" as const,
            };
      }
    })
  );

  for (const a of attempts) {
    if (a.outcome === "blocked") {
      ok(`${a.label} refused before any execution`);
    } else if (a.outcome === "passed") {
      ko(`${a.label} — SHOULD HAVE BEEN REFUSED`);
    } else {
      ko(`${a.label} — wrong error: ${a.detail}`);
    }
  }

  // ── 3. source fetch, with SHA returned ────────────────────────────────────
  const origin = `${WORK}/origin`;
  await exec(
    client,
    `sudo rm -rf ${quoteArg(WORK)} && sudo mkdir -p ${quoteArg(origin)} && sudo chown -R "$USER" ${quoteArg(WORK)} && ` +
      `cd ${quoteArg(origin)} && ` +
      `printf '{"name":"v","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf 'require("http").createServer((q,r)=>r.end("ok")).listen(3000)' > s.js && ` +
      "git init -q . && git config user.email v@x && git config user.name v && " +
      "git add -A && git commit -q -m init"
  );

  const sha = await fetchSource(client, {
    branch: "master",
    dir: `${WORK}/src`,
    repoUrl: `file://${origin}`,
  });
  if (/^[0-9a-f]{40}$/.test(sha)) {
    ok(`fetchSource returns a full SHA: ${sha.slice(0, 8)}`);
  } else {
    ko(`unexpected SHA: ${sha}`);
  }

  // ── 4. end-to-end build ───────────────────────────────────────────────────
  let lines = 0;
  await buildImage(client, {
    dir: `${WORK}/src`,
    imageTag: TAG,
    onStderr: () => {
      lines += 1;
    },
    onStdout: () => {
      lines += 1;
    },
  });
  ok(`build succeeded, ${lines} log fragment(s) streamed`);

  const imgs = await exec(
    client,
    `sudo docker image inspect ${quoteArg(TAG)} --format '{{.Id}}'`
  );
  if (imgs.code === 0 && imgs.stdout.trim().startsWith("sha256:")) {
    ok("image exists in the local Docker store");
  } else {
    ko("image not found after the build");
  }

  // ── 5. the healthcheck binary is actually IN the image ────────────────────
  // `verify-build-dir` only checks that Noddle ASKS for curl. This checks that
  // it landed — and it runs the probe the way a HEALTHCHECK does, in a
  // non-login `sh -c`, because that is where the PATH differs.
  //
  // Railpack's Debian base ships neither curl nor wget. If the forced package
  // list ever stops working, every deployed task stops converging and it reads
  // as a Traefik routing bug, so this failure has to be caught here instead.
  const probe = await exec(
    client,
    `sudo docker run --rm --entrypoint /bin/sh ${quoteArg(TAG)} -c 'command -v curl'`
  );
  if (probe.code === 0 && probe.stdout.trim() !== "") {
    ok(`curl is on the image's non-login PATH: ${probe.stdout.trim()}`);
  } else {
    ko("curl is MISSING from the built image — every healthcheck would fail");
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (client) {
    await exec(
      client,
      `sudo docker buildx rm ${quoteArg(BUILDX_BUILDER)} 2>/dev/null`
    );
    await exec(
      client,
      `sudo docker rm -f ${quoteArg(BUILDKIT_CONTAINER)} 2>/dev/null`
    );
    await exec(client, `sudo docker image rm -f ${quoteArg(TAG)} 2>/dev/null`);
    await exec(client, `sudo rm -rf ${quoteArg(WORK)}`);
    disconnect(client);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
