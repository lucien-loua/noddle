import {
  decryptSecret,
  encryptSecret,
  resolveRetainedSecret,
  secretContext,
} from "@noddle/crypto";
import { registries, services } from "@noddle/db/schema";
import {
  registryIdSchema,
  registrySchema,
  serviceRegistrySchema,
} from "@noddle/shared/validation/registry";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded, runRead } from "@/lib/permission.server";

export interface RegistryView {
  createdAt: string;
  id: string;
  imagePrefix: string;
  name: string;
  registryUrl: string;
  username: string;
}

const BEARER_REALM = /realm="([^"]+)"/;
const BEARER_SERVICE = /service="([^"]+)"/;

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * A Bearer token when the registry demands one.
 *
 * ghcr.io and the Hub respond 401 to `/v2/` EVEN with valid credentials:
 * they advertise a `WWW-Authenticate: Bearer realm=…`, and it's up to the
 * client to fetch a token using Basic auth. Without this step, a correct
 * password would read as "credentials refused" — the false negative this
 * project refuses everywhere else.
 */
async function bearerFor(
  challenge: string,
  username: string,
  password: string
): Promise<string | null> {
  const realm = BEARER_REALM.exec(challenge)?.[1];
  if (!realm) {
    return null;
  }
  const service = BEARER_SERVICE.exec(challenge)?.[1];
  const url = new URL(realm);
  if (service) {
    url.searchParams.set("service", service);
  }

  const res = await fetch(url, {
    headers: { authorization: basic(username, password) },
  });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as { access_token?: string; token?: string };
  return body.token ?? body.access_token ?? null;
}

/**
 * The HTTP status decides, never the absence of a body.
 *
 * Same lesson as `HeadBucket` for S3: a registry doesn't always return a
 * usable message, but it always returns a code.
 */
async function pingRegistry(
  host: string,
  username: string,
  password: string
): Promise<{ error: string | null }> {
  const endpoint = `https://${host}/v2/`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { authorization: basic(username, password) },
    });
  } catch {
    return {
      error: `${host} could not be reached over https`,
    };
  }

  if (res.status === 401) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (challenge.toLowerCase().startsWith("bearer")) {
      const token = await bearerFor(challenge, username, password);
      if (!token) {
        return { error: "credentials refused by the registry" };
      }
      const retry = await fetch(endpoint, {
        headers: { authorization: `Bearer ${token}` },
      });
      return retry.ok
        ? { error: null }
        : { error: "credentials refused by the registry" };
    }
    return { error: "credentials refused by the registry" };
  }

  if (res.status === 404) {
    return { error: `${host} answered, but exposes no /v2/ registry API` };
  }
  if (!res.ok) {
    return { error: `${host} answered ${res.status}` };
  }
  return { error: null };
}

export const getRegistries = createServerFn({ method: "GET" }).handler(
  async (): Promise<RegistryView[]> =>
    runRead({
      permission: { action: "read", resource: "registry" },
      read: async () => {
        const rows = await db.query.registries.findMany({
          orderBy: desc(registries.createdAt),
        });

        return rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          imagePrefix: row.imagePrefix,
          name: row.name,
          registryUrl: row.registryUrl,
          username: row.username,
        }));
      },
    })
);

async function resolvePassword(data: {
  id?: string;
  password: string;
}): Promise<string> {
  return await resolveRetainedSecret(
    data.password,
    async () => {
      if (!data.id) {
        return null;
      }
      const existing = await db.query.registries.findFirst({
        where: eq(registries.id, data.id),
      });
      if (!existing) {
        throw new Error("this registry no longer exists");
      }
      return decryptSecret(
        existing.passwordEncrypted,
        env.appKey,
        secretContext.registry(existing.id)
      );
    },
    "a password is required"
  );
}

export const testRegistry = createServerFn({ method: "POST" })
  .validator(registrySchema)
  .handler(
    async ({ data }): Promise<{ error: string | null }> =>
      // A connection test, not a change: the object is the registry URL
      // being probed, which may not be a saved row yet.
      runGuarded({
        permission: { action: "create", resource: "registry" },
        run: async () => {
          const password = await resolvePassword(data);
          return await pingRegistry(data.registryUrl, data.username, password);
        },
        target: () => ({ id: data.id ?? data.registryUrl, name: data.name }),
      })
  );

export const saveRegistry = createServerFn({ method: "POST" })
  .validator(registrySchema)
  .handler(async ({ data }): Promise<{ id: string; ok: true }> => {
    const guarded = await runGuarded({
      permission: { action: "create", resource: "registry" },
      run: async () => {
        const password = await resolvePassword(data);

        if (data.id) {
          await db
            .update(registries)
            .set({
              imagePrefix: data.imagePrefix,
              name: data.name,
              passwordEncrypted: encryptSecret(
                password,
                env.appKey,
                secretContext.registry(data.id)
              ),
              registryUrl: data.registryUrl,
              updatedAt: new Date(),
              username: data.username,
            })
            .where(eq(registries.id, data.id));
          return { id: data.id, ok: true as const };
        }

        // The AAD binds the ciphertext to ITS row: the id must exist before
        // encryption, so it's drawn here rather than via `defaultRandom()`.
        const id = crypto.randomUUID();
        await db.insert(registries).values({
          id,
          imagePrefix: data.imagePrefix,
          name: data.name,
          passwordEncrypted: encryptSecret(
            password,
            env.appKey,
            secretContext.registry(id)
          ),
          registryUrl: data.registryUrl,
          username: data.username,
        });
        return { id, ok: true as const };
      },
      // The registry, never its password.
      target: ({ result }) => ({ id: result.id, name: data.name }),
    });
    // The id goes back to the caller: the Docker provider tab creates a
    // registry and links it to the service in one move, and it cannot look
    // the row up by name without racing another rename.
    return { id: guarded.id, ok: guarded.ok };
  });

export const deleteRegistry = createServerFn({ method: "POST" })
  .validator(registryIdSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.registries.findFirst({ where: eq(registries.id, data.id) }),
        notFoundMessage: "registry not found",
        permission: { action: "delete", resource: "registry" },
        run: async ({ row }) => {
          await db.delete(registries).where(eq(registries.id, row.id));
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

/**
 * Enough to fill a service's selector: an id and a name, nothing else.
 *
 * Guarded by `service: create` rather than `registry: read`: this is a
 * matter of service configuration, and a `deployer` who ships has the
 * right to know where their image goes. No secret comes out of it — no
 * URL, no username, no password.
 */
export const getRegistryOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<Array<{ id: string; name: string }>> =>
    runRead({
      permission: { action: "create", resource: "service" },
      read: async () => {
        const rows = await db.query.registries.findMany({
          columns: { id: true, name: true },
          orderBy: desc(registries.createdAt),
        });
        return rows;
      },
    })
);

export const setServiceRegistry = createServerFn({ method: "POST" })
  .validator(serviceRegistrySchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.services.findFirst({
            where: eq(services.id, data.serviceId),
          }),
        notFoundMessage: "service not found",
        permission: { action: "create", resource: "service" },
        run: async ({ row }) => {
          await db
            .update(services)
            .set({ registryId: data.registryId, updatedAt: new Date() })
            .where(eq(services.id, row.id));
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );
