#!/usr/bin/env bun
import { randomUUID } from "node:crypto";

import { parseArgs, UsageError, waitTimeoutMs } from "#args";
import type { Command, ParsedArgs } from "#args";
import {
  CliError,
  createClient,
  deploymentExitCode,
  resolveConfig,
} from "#client";
import { HELP } from "#help";
import { table } from "#table";
import { VERSION } from "#version";

const POLL_MS = 3000;
const MAX_POLL_FAILURES = 5;
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
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    let deployment: Awaited<ReturnType<typeof client.deployment>>;
    try {
      deployment = await client.deployment(id);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_POLL_FAILURES) {
        throw error;
      }
      if (!json) {
        out(`  lost contact, retrying (${consecutiveFailures})`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
      continue;
    }

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

type Client = ReturnType<typeof createClient>;
type Handler = (client: Client, args: ParsedArgs) => Promise<number> | number;

function requireArg(args: ParsedArgs, what: string): string {
  const [value] = args.positional;
  if (!value) {
    throw new UsageError(`noddle ${args.command} needs ${what}.`);
  }
  return value;
}

const HANDLERS: Record<Command, Handler> = {
  deploy: async (client, args) => {
    const wanted = requireArg(args, "a service name or id");
    const started = await client.deploy(wanted, randomUUID());
    if (!args.flags.json) {
      out(`deploying ${started.service.name} (${started.deploymentId})`);
    }
    if (!args.flags.wait) {
      emit(args.flags.json, started, () => "queued");
      return 0;
    }
    return await waitForDeployment(
      client,
      started.deploymentId,
      waitTimeoutMs(args.flags.timeout),
      args.flags.json
    );
  },

  logs: async (client, args) => {
    const logs = await client.deploymentLogs(
      requireArg(args, "a deployment id")
    );
    if (args.flags.json) {
      out(JSON.stringify(logs, null, 2));
    } else if (logs.log) {
      process.stdout.write(
        logs.log.endsWith("\n") ? logs.log : `${logs.log}\n`
      );
    } else {
      out("(no logs kept for this deployment)");
    }
    return logs.done ? deploymentExitCode(logs.status) : 0;
  },

  servers: async (client, args) => {
    const { servers } = await client.servers();
    emit(args.flags.json, { servers }, () =>
      table(
        ["NAME", "HOST", "STATUS"],
        servers.map((s) => [s.name, s.host, s.status])
      )
    );
    return 0;
  },

  services: async (client, args) => {
    const { services } = await client.services();
    emit(args.flags.json, { services }, () =>
      table(
        ["NAME", "STATUS", "ID"],
        services.map((s) => [s.name, s.status, s.id])
      )
    );
    return 0;
  },

  status: async (client, args) => {
    const deployment = await client.deployment(
      requireArg(args, "a deployment id")
    );
    emit(args.flags.json, deployment, () => deployment.status);
    return deployment.done ? deploymentExitCode(deployment.status) : 0;
  },

  whoami: async (client, args) => {
    const me = await client.whoami();
    emit(args.flags.json, me, () =>
      [
        `${me.email} (${me.role ?? "no role"})`,
        `token: ${me.token.name}`,
        `scopes: ${me.scopes.join(", ") || "none"}`,
      ].join("\n")
    );
    return 0;
  },
};

async function run(args: ParsedArgs): Promise<number> {
  if (args.flags.version) {
    out(VERSION);
    return 0;
  }
  if (args.flags.help || args.command === null) {
    out(HELP);
    return args.command === null && !args.flags.help ? EXIT_USAGE : 0;
  }
  const client = createClient(resolveConfig(args.flags, process.env));
  return await HANDLERS[args.command](client, args);
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
