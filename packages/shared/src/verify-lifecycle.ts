// tier: pure
import { check, expectThrows, runVerify } from "@noddle/testing";

import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isStuckDeleting,
  markDeleting,
  markDeploying,
  markFailed,
  markRunning,
  settle,
} from "#lifecycle";

await runVerify("lifecycle transitions", () => {
  check(
    "created → deploying is allowed",
    canTransition("created", "deploying")
  );
  check("running → deleting is allowed", canTransition("running", "deleting"));
  check("deleting → running is refused", !canTransition("deleting", "running"));

  expectThrows(
    "assertTransition throws IllegalTransitionError",
    () => assertTransition("deleting", "running"),
    (e) => e instanceof IllegalTransitionError
  );

  const deploying = markDeploying("created");
  check(
    "markDeploying clears lastError",
    deploying.status === "deploying" && deploying.lastError === null
  );

  const running = markRunning("deploying");
  check("markRunning from deploying", running.status === "running");

  const failed = markFailed("deleting", "swarm timeout");
  check(
    "markFailed while deleting stays deleting with reason",
    failed.status === "deleting" && failed.lastError === "swarm timeout"
  );

  const del = markDeleting("running");
  check("markDeleting from running", del.status === "deleting");

  check(
    "isStuckDeleting detects lastError under deleting",
    isStuckDeleting({ lastError: "boom", status: "deleting" }) &&
      !isStuckDeleting({ lastError: null, status: "deleting" })
  );

  check("settle completed → succeeded", settle("completed") === "succeeded");
  check(
    "settle rollback_completed → rolled_back",
    settle("rollback_completed") === "rolled_back"
  );
});
