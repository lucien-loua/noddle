const NO_STORE = Object.freeze({ "cache-control": "no-store" });

export interface ApiError {
  error: string;
  message: string;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiClientError";
    this.status = status;
  }
}

export function notFound(what: string): ApiClientError {
  return new ApiClientError(404, "not_found", `No ${what} with that id.`);
}

export const OPAQUE_FAILURE =
  "Something went wrong on this Noddle. The error is in the dashboard log.";

export function renderHandlerError(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (error instanceof ApiClientError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: "internal_error", message: OPAQUE_FAILURE, status: 500 };
}

export function apiError(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return Response.json({ error, message } satisfies ApiError, {
    headers: { ...NO_STORE, ...headers },
    status,
  });
}
