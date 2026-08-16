// bun run packages/git-provider-credentials/src/verify-hooks.ts
//
// Pure: no database, no GitLab. What is covered here is the HTTP shape of the
// hook calls — a wrong field name is accepted by GitLab with a 201 and simply
// never delivers, which is the same silent-and-looks-fine failure Repository
// hooks exist to remove.
import {
  createProjectHook,
  deleteProjectHook,
  GitlabError,
  listProjectHooks,
} from "@noddle/git-provider/gitlab";
import { check, expectThrowsAsync, runVerify } from "@noddle/testing";

const URL_BASE = "https://gitlab.example.com";
const TOKEN = "at-1";
const NESTED = "group/sub/app";

interface Call {
  body: string;
  method: string;
  url: string;
}

function stub(status: number, payload: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    calls.push({
      body: init?.body ? String(init.body) : "",
      method: init?.method ?? "GET",
      url,
    });
    return Promise.resolve(
      new Response(payload === undefined ? null : JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status,
      })
    );
  };
  return { calls, fetchImpl };
}

await runVerify("git-provider-credentials/hooks", async () => {
  // ── the project path is URL-encoded, subgroups included ───────────────
  const listed = stub(200, [{ id: 7, url: "https://noddle.test/hook" }]);
  const hooks = await listProjectHooks(
    URL_BASE,
    TOKEN,
    NESTED,
    listed.fetchImpl
  );
  check(
    "a subgroup path is encoded, not split into path segments",
    listed.calls[0]?.url.includes("group%2Fsub%2Fapp") === true,
    listed.calls[0]?.url
  );
  check(
    "hook ids come back as strings",
    hooks.length === 1 && hooks[0]?.id === "7"
  );

  // ── creation carries the events Noddle actually needs ────────────────
  const created = stub(201, { id: 9, url: "https://noddle.test/hook" });
  const hook = await createProjectHook(
    URL_BASE,
    TOKEN,
    NESTED,
    { hookUrl: "https://noddle.test/hook", token: "s3cret" },
    created.fetchImpl
  );
  const body = new URLSearchParams(created.calls[0]?.body ?? "");
  check("created hook id is a string", hook.id === "9");
  check("POSTed", created.calls[0]?.method === "POST");
  check(
    "push AND merge request events, matching the GitHub App's defaults",
    body.get("push_events") === "true" &&
      body.get("merge_requests_events") === "true"
  );
  check(
    "the shared secret goes in `token`, which GitLab echoes as x-gitlab-token",
    body.get("token") === "s3cret"
  );
  check("the hook URL is sent", body.get("url") === "https://noddle.test/hook");

  // ── removal ──────────────────────────────────────────────────────────
  const gone = stub(404, undefined);
  await deleteProjectHook(URL_BASE, TOKEN, NESTED, "9", gone.fetchImpl);
  check(
    "a hook already deleted by hand is success, not a failure",
    gone.calls[0]?.method === "DELETE"
  );

  const refused = stub(403, { message: "403 Forbidden" });
  await expectThrowsAsync(
    "a 403 is raised so the caller can record it",
    () => deleteProjectHook(URL_BASE, TOKEN, NESTED, "9", refused.fetchImpl),
    (err) => err instanceof GitlabError && err.status === 403
  );

  // Maintainer-or-better is required to create a hook. The caller turns this
  // into a recorded failure rather than a failed save, so it has to arrive as
  // a throw carrying the status.
  const denied = stub(403, { message: "403 Forbidden" });
  await expectThrowsAsync(
    "a refused creation carries GitLab's status",
    () =>
      createProjectHook(
        URL_BASE,
        TOKEN,
        NESTED,
        { hookUrl: "https://noddle.test/hook", token: "s" },
        denied.fetchImpl
      ),
    (err) => err instanceof GitlabError && err.status === 403
  );
});
