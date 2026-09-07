export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_IDEMPOTENCY_KEY = 200;

export interface StoredResponse {
  body: unknown;
  status: number;
}

export interface KeyValueStore {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    mode: "EX",
    seconds: number
  ) => Promise<unknown>;
}

export function idempotencyKey(tokenId: string, presented: string): string {
  return `idem:${tokenId}:${presented}`;
}

export function readIdempotencyHeader(request: Request): string | null {
  const raw = request.headers.get("idempotency-key")?.trim();
  if (!raw || raw.length > MAX_IDEMPOTENCY_KEY) {
    return null;
  }
  return raw;
}

export function idempotencyStore(store: KeyValueStore) {
  return {
    async remember(
      tokenId: string,
      presented: string,
      response: StoredResponse
    ): Promise<void> {
      await store.set(
        idempotencyKey(tokenId, presented),
        JSON.stringify(response),
        "EX",
        IDEMPOTENCY_TTL_SECONDS
      );
    },

    async replay(
      tokenId: string,
      presented: string
    ): Promise<StoredResponse | null> {
      const stored = await store.get(idempotencyKey(tokenId, presented));
      return stored ? (JSON.parse(stored) as StoredResponse) : null;
    },
  };
}
