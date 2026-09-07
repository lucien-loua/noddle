// tier: pure
import { check, runVerify, suite } from "@noddle/testing";

import {
  ApiClientError,
  notFound,
  OPAQUE_FAILURE,
  renderHandlerError,
} from "@/lib/api-errors";

const LEAKY = [
  new Error(
    "connect ECONNREFUSED postgres://noddle:hunter2@10.0.0.5:5432/noddle"
  ),
  new Error(
    'insert into "services" ("swarm_name") violates not-null constraint'
  ),
  new Error("getaddrinfo ENOTFOUND redis.internal"),
  Object.assign(new Error("boom"), { stack: "at /noddle/apps/dashboard/src" }),
];

await runVerify("api v1 error rendering", async () => {
  await suite("a curated error is shown as written", () => {
    const rendered = renderHandlerError(
      new ApiClientError(409, "conflict", "That name is taken.")
    );
    check("its status is kept", rendered.status === 409);
    check("its code is kept", rendered.code === "conflict");
    check("its message is kept", rendered.message === "That name is taken.");

    const missing = renderHandlerError(notFound("service"));
    check("a missing row is 404, not 400", missing.status === 404);
    check("and says so", missing.code === "not_found");
    check(
      "without echoing an id back",
      !missing.message.includes("undefined") && missing.message.length < 60
    );
  });

  await suite("an unexpected error never reaches the caller", () => {
    for (const error of LEAKY) {
      const rendered = renderHandlerError(error);
      check(
        `"${error.message.slice(0, 34)}…" becomes a 500`,
        rendered.status === 500
      );
      check(
        "and its text is not in the response",
        !rendered.message.includes(error.message),
        rendered.message
      );
    }

    check(
      "no credential survives",
      !renderHandlerError(LEAKY[0] as Error).message.includes("hunter2")
    );
    check(
      "no host survives",
      !renderHandlerError(LEAKY[2] as Error).message.includes("redis.internal")
    );
    check(
      "no column name survives",
      !renderHandlerError(LEAKY[1] as Error).message.includes("swarm_name")
    );
  });

  await suite("anything thrown that is not an Error is handled too", () => {
    for (const thrown of ["a string", 42, null, undefined, { secret: "x" }]) {
      const rendered = renderHandlerError(thrown);
      check(
        `${JSON.stringify(thrown) ?? "undefined"} is opaque`,
        rendered.status === 500 && rendered.message === OPAQUE_FAILURE
      );
    }
  });
});
