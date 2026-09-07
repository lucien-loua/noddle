#!/usr/bin/env bun
import { randomUUID } from "node:crypto";

import { parseArgs, UsageError, waitTimeoutMs } from "#args";
import type { ParsedArgs } from "#args";
import {
  CliError,
  createClient,
  deploymentExitCode,
  resolveConfig,
} from "#client";
import { HELP } from "#help";
import { table } from "#table";

const POLL_MS = 3000;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

function out(value: string): void {
  process.stdout.write(`${value}\n`);
}

function emit(json: boolean, payload: unknown, human: () => string): void {
  out(json ? JSON.stringify(payload, null, 2) : human());
}

async function waitForDeployment(
  client: ReturnType<typeof createClient>,
  id: string,
  timeout: number,
  json: boolean
): Promise<number> {
  const deadline = Date.now() + timeout;
  let last = "";

  while (Date.now() < deadline) {
    const deployment = await client.deployment(id);
    if (deployment.status !== last) {
      last = deployment.status;
      if (!json) {
        out(`  ${deployment.status}`);
      }
    }
    if (deployment.done) {
      emit(json, deployment, () => `${deployment.status}`);
      return deploymentExitCode(deployment.status);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }

  throw new CliError(
    `The deployment was still running after the timeout. It is not cancelled — check with: noddle status ${id}`
  );
}

async function run(args: ParsedArgs): Promise<number> {
  const { flags } = args;

  if (flags.help || args.command === null) {
    out(HELP);
    return args.command === null && !flags.help ? EXIT_USAGE : 0;
  }

  const client = createClient(resolveConfig(flags, process.env));

  if (args.command === "whoami") {
    const me = await client.whoami();
    emit(flags.json, me, () =>
      [
        `${me.email} (${me.role ?? "no role"})`,
        `token: ${me.token.name}`,
        `scopes: ${me.scopes.join(", ") || "none"}`,
      ].join("\n")
    );
    return 0;
  }

  if (args.command === "servers") {
    const { servers } = await client.servers();
    emit(flags.json, { servers }, () =>
      table(
        ["NAME", "HOST", "STATUS"],
        servers.map((s) => [s.name, s.host, s.status])
      )
    );
    return 0;
  }

  if (args.command === "services") {
    const { services } = await client.services();
    emit(flags.json, { services }, () =>
      table(
        ["NAME", "STATUS", "ID"],
        services.map((s) => [s.name, s.status, s.id])
      )
    );
    return 0;
  }

  if (args.command === "status") {
    const [id] = args.positional;
    if (!id) {
      throw new UsageError("noddle status needs a deployment id.");
    }
    const deployment = await client.deployment(id);
    emit(flags.json, deployment, () => deployment.status);
    return deployment.done ? deploymentExitCode(deployment.status) : 0;
  }

  const [serviceId] = args.positional;
  if (!serviceId) {
    throw new UsageError("noddle deploy needs a service id.");
  }
  const started = await client.deploy(serviceId, randomUUID());
  if (!flags.json) {
    out(`deploying ${started.service.name} (${started.deploymentId})`);
  }
  if (!flags.wait) {
    emit(flags.json, started, () => "queued");
    return 0;
  }
  return await waitForDeployment(
    client,
    started.deploymentId,
    waitTimeoutMs(flags.timeout),
    flags.json
  );
}

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${HELP}\n`);
    process.exitCode = EXIT_USAGE;
  } else if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_FAILURE;
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = EXIT_FAILURE;
  }
}
