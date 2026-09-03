// tier: pure
import { check, expectThrows, runVerify } from "@noddle/testing";

import {
  newDatabaseSwarmName,
  newStackSwarmName,
  swarmServiceName,
  SWARM_NAME_MAX,
} from "#swarm-names";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

await runVerify("swarm names", () => {
  const atCap = "n".repeat(48);

  check(
    "a database name at the 48-char validation cap fits the 63-char limit",
    newDatabaseSwarmName({ id: ID, name: atCap }).length <= SWARM_NAME_MAX
  );
  check(
    "a service name at the 48-char validation cap fits the 63-char limit",
    swarmServiceName({ id: ID, name: atCap }).length <= SWARM_NAME_MAX
  );

  expectThrows(
    "a database name past the limit is refused, not silently truncated",
    () => newDatabaseSwarmName({ id: ID, name: "n".repeat(60) })
  );
  expectThrows(
    "a service name past the limit is refused, not silently truncated",
    () => swarmServiceName({ id: ID, name: "n".repeat(60) })
  );

  check(
    "a stack name is self-truncating and never needs the check",
    newStackSwarmName({ id: ID, name: "n".repeat(200) }).length <=
      SWARM_NAME_MAX
  );
});
