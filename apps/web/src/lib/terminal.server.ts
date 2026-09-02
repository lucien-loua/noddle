import { auditLog, databases, servers, services } from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import {
  execArgv,
  openExecPty,
  openShell,
  quoteArg,
} from "@noddle/ssh-executor";
import type { PtySession, SshClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import type { Session } from "@/lib/auth.server";
import { auth } from "@/lib/auth.server";
import { CONTAINER_ID, readKind } from "@/lib/container-read.server";
import { db } from "@/lib/db.server";
import { can } from "@/lib/permissions";
import type { Permission } from "@/lib/permissions";
import { connectToServer } from "@/lib/ssh.server";

const UUID = /^[0-9a-f-]{36}$/i;
const ALLOWED_SHELLS = new Set(["sh", "bash", "ash"]);
const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";

export const TERMINAL_SSH_PATH = "/api/terminal/ssh";
export const TERMINAL_CONTAINER_PATH = "/api/terminal/container";

export type TerminalKind = "ssh" | "container";

export interface TerminalSocketData {
  cookie: string | null;
  forwardedFor: string | null;
  kind: TerminalKind;
  params: Record<string, string>;
  session?: PtySession;
  ssh?: SshClient;
  userAgent: string | null;
}

export function isTerminalPath(pathname: string): boolean {
  return pathname === TERMINAL_SSH_PATH || pathname === TERMINAL_CONTAINER_PATH;
}

export function terminalKindFromPath(pathname: string): TerminalKind | null {
  if (pathname === TERMINAL_SSH_PATH) {
    return "ssh";
  }
  if (pathname === TERMINAL_CONTAINER_PATH) {
    return "container";
  }
  return null;
}

function roleOf(session: Session): string | null {
  return session.user.role ?? null;
}

async function requireTerminalPermission(
  session: Session,
  permission: Permission,
  target: { id: string; name: string },
  meta: { forwardedFor: string | null; userAgent: string | null }
): Promise<boolean> {
  const allowed = can(roleOf(session), permission.resource, permission.action);
  try {
    await db.insert(auditLog).values({
      action: permission.action,
      actorEmail: session.user.email,
      actorUserId: session.user.id,
      ipAddress: meta.forwardedFor?.split(",")[0]?.trim() ?? null,
      outcome: allowed ? "allowed" : "denied",
      resource: permission.resource,
      resourceId: target.id,
      resourceName: target.name,
      role: roleOf(session),
      userAgent: meta.userAgent,
    });
  } catch (error) {
    process.stderr.write(
      `audit log write failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
  return allowed;
}

export async function sessionFromCookie(
  cookie: string | null
): Promise<Session | null> {
  if (!cookie) {
    return null;
  }
  const headers = new Headers({ cookie });
  return await auth.api.getSession({ headers });
}

function parseShell(raw: string | null | undefined): string {
  if (!(raw && ALLOWED_SHELLS.has(raw))) {
    return "sh";
  }
  return raw;
}

function parseDims(params: Record<string, string>): {
  cols: number;
  rows: number;
} {
  const cols = Math.trunc(Number(params.cols || "80"));
  const rows = Math.trunc(Number(params.rows || "24"));
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
  };
}

async function findContainerId(
  client: SshClient,
  swarmName: string
): Promise<string | null> {
  const filter = `label=${SWARM_SERVICE_LABEL}=${swarmName}`;
  const result = await execArgv(client, [
    "docker",
    "ps",
    "-q",
    "-l",
    "--filter",
    filter,
  ]);
  const id = result.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (!(id && CONTAINER_ID.test(id))) {
    return null;
  }
  return id;
}

export type TerminalOpenResult =
  | { ok: true; pty: PtySession; ssh: SshClient; label: string }
  | { ok: false; message: string; status: number };

interface AuditMeta {
  forwardedFor: string | null;
  userAgent: string | null;
}

function dockerExecCommand(containerId: string, shell: string): string {
  return [
    "docker",
    "exec",
    "-it",
    "-w",
    "/",
    quoteArg(containerId),
    quoteArg(shell),
  ].join(" ");
}

async function openSshTerminal(
  session: Session,
  params: Record<string, string>,
  dims: { cols: number; rows: number },
  meta: AuditMeta
): Promise<TerminalOpenResult> {
  const { serverId } = params;
  if (!(serverId && UUID.test(serverId))) {
    return { message: "invalid serverId", ok: false, status: 400 };
  }
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    return { message: "server not found", ok: false, status: 404 };
  }
  const allowed = await requireTerminalPermission(
    session,
    { action: "shell", resource: "server" },
    { id: server.id, name: server.name },
    meta
  );
  if (!allowed) {
    return { message: "forbidden", ok: false, status: 403 };
  }
  const ssh = await connectToServer(server);
  try {
    const pty = await openShell(ssh, dims);
    return { label: server.name, ok: true, pty, ssh };
  } catch (error) {
    ssh.end();
    throw error;
  }
}

async function openContainerExec(
  session: Session,
  opts: {
    dims: { cols: number; rows: number };
    id: string;
    label: string;
    meta: AuditMeta;
    server: typeof servers.$inferSelect;
    shell: string;
    swarmName: string;
  }
): Promise<TerminalOpenResult> {
  const allowed = await requireTerminalPermission(
    session,
    { action: "shell", resource: "container" },
    { id: opts.id, name: opts.label },
    opts.meta
  );
  if (!allowed) {
    return { message: "forbidden", ok: false, status: 403 };
  }
  const ssh = await connectToServer(opts.server);
  try {
    const containerId = await findContainerId(ssh, opts.swarmName);
    if (!containerId) {
      ssh.end();
      return {
        message: "no running container for this target",
        ok: false,
        status: 404,
      };
    }
    const pty = await openExecPty(
      ssh,
      dockerExecCommand(containerId, opts.shell),
      opts.dims
    );
    return { label: opts.label, ok: true, pty, ssh };
  } catch (error) {
    ssh.end();
    throw error;
  }
}

async function openServerContainerTerminal(
  session: Session,
  params: Record<string, string>,
  dims: { cols: number; rows: number },
  shell: string,
  meta: AuditMeta
): Promise<TerminalOpenResult> {
  const { containerId, serverId } = params;
  if (!(serverId && UUID.test(serverId))) {
    return { message: "invalid serverId", ok: false, status: 400 };
  }
  if (!(containerId && CONTAINER_ID.test(containerId))) {
    return { message: "invalid containerId", ok: false, status: 400 };
  }
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    return { message: "server not found", ok: false, status: 404 };
  }

  const ssh = await connectToServer(server);
  try {
    const found = await readKind(ssh, containerId);
    if (!found) {
      ssh.end();
      return { message: "container not found", ok: false, status: 404 };
    }
    const allowed = await requireTerminalPermission(
      session,
      { action: "shell", resource: "container" },
      { id: containerId, name: found.name },
      meta
    );
    if (!allowed) {
      ssh.end();
      return { message: "forbidden", ok: false, status: 403 };
    }
    if (found.kind === "control-plane") {
      ssh.end();
      return {
        message: `${found.name} is part of Noddle itself and cannot be shelled into from here.`,
        ok: false,
        status: 403,
      };
    }
    const pty = await openExecPty(
      ssh,
      dockerExecCommand(containerId, shell),
      dims
    );
    return { label: found.name, ok: true, pty, ssh };
  } catch (error) {
    ssh.end();
    throw error;
  }
}

async function openContainerTerminal(
  session: Session,
  params: Record<string, string>,
  dims: { cols: number; rows: number },
  meta: AuditMeta
): Promise<TerminalOpenResult> {
  const { target, id } = params;
  const shell = parseShell(params.shell);

  if (target === "container") {
    return openServerContainerTerminal(session, params, dims, shell, meta);
  }

  if (!(id && UUID.test(id))) {
    return { message: "invalid id", ok: false, status: 400 };
  }
  if (target !== "service" && target !== "database") {
    return { message: "invalid target", ok: false, status: 400 };
  }

  if (target === "database") {
    const database = await db.query.databases.findFirst({
      where: eq(databases.id, id),
      with: { server: true },
    });
    if (!database) {
      return { message: "database not found", ok: false, status: 404 };
    }
    return openContainerExec(session, {
      dims,
      id: database.id,
      label: database.name,
      meta,
      server: database.server,
      shell,
      swarmName: database.swarmName,
    });
  }

  const service = await db.query.services.findFirst({
    where: eq(services.id, id),
    with: { server: true },
  });
  if (!service) {
    return { message: "service not found", ok: false, status: 404 };
  }
  return openContainerExec(session, {
    dims,
    id: service.id,
    label: service.name,
    meta,
    server: service.server,
    shell,
    swarmName: swarmServiceName(service),
  });
}

export async function openTerminalSession(
  data: TerminalSocketData
): Promise<TerminalOpenResult> {
  const session = await sessionFromCookie(data.cookie);
  if (!session) {
    return { message: "not authenticated", ok: false, status: 401 };
  }

  const dims = parseDims(data.params);
  const meta = {
    forwardedFor: data.forwardedFor,
    userAgent: data.userAgent,
  };

  if (data.kind === "ssh") {
    return openSshTerminal(session, data.params, dims, meta);
  }
  return openContainerTerminal(session, data.params, dims, meta);
}

export type TerminalClientFrame =
  | { type: "resize"; cols: number; rows: number }
  | { type: "stdin"; data: string };

export function parseClientMessage(
  raw: string | Buffer
): TerminalClientFrame | { type: "raw"; data: string | Buffer } {
  if (typeof raw !== "string") {
    return { data: raw, type: "raw" };
  }
  if (!raw.startsWith("{")) {
    return { data: raw, type: "raw" };
  }
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      cols?: number;
      rows?: number;
      data?: string;
    };
    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number" &&
      parsed.cols > 0 &&
      parsed.rows > 0
    ) {
      return { cols: parsed.cols, rows: parsed.rows, type: "resize" };
    }
    if (parsed.type === "stdin" && typeof parsed.data === "string") {
      return { data: parsed.data, type: "stdin" };
    }
  } catch {}
  return { data: raw, type: "raw" };
}
