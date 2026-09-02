// tier: pure
import {
  createProjectHook,
  deleteProjectHook,
  GitlabError,
  listProjectHooks,
  updateProjectHook,
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

  const moved = stub(200, { id: 9, url: "https://new.example/hook" });
  const repointed = await updateProjectHook(
    URL_BASE,
    TOKEN,
    NESTED,
    "9",
    { hookUrl: "https://new.example/hook", token: "s3cret" },
    moved.fetchImpl
  );
  const movedBody = new URLSearchParams(moved.calls[0]?.body ?? "");
  check(
    "repointing is a PUT on the existing hook",
    moved.calls[0]?.method === "PUT"
  );
  check(
    "it addresses the hook by id rather than creating another",
    moved.calls[0]?.url.endsWith("/hooks/9") === true,
    moved.calls[0]?.url
  );
  check(
    "the new URL is sent",
    movedBody.get("url") === "https://new.example/hook"
  );
  check(
    "the secret is re-sent, since GitLab does not return it",
    movedBody.get("token") === "s3cret"
  );
  check("the same hook comes back", repointed.id === "9");

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
