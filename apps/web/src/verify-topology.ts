// tier: pure
// bun run apps/web/src/verify-topology.ts
import { check, runVerify } from "@noddle/testing";

import {
  buildTopology,
  INTERNET_NODE_ID,
} from "@/components/features/environment/topology-graph";
import type { TopologyScope } from "@/components/features/environment/topology-graph";

const ENVIRONMENT = "env-1";
const PROJECT = "proj-1";

const service = (id: string, domains: number) => ({
  domains: Array.from({ length: domains }, (_, i) => ({ host: `${id}-${i}` })),
  id,
  name: id,
  serverName: "vps-1",
  status: "running",
});

const scope = (over: Partial<TopologyScope> = {}): TopologyScope => ({
  databases: [],
  environmentId: ENVIRONMENT,
  projectId: PROJECT,
  services: [],
  stacks: [],
  ...over,
});

const database = (id: string) => ({
  engine: "postgres" as const,
  id,
  name: id,
  serverName: "vps-1",
  status: "running",
});

const stack = (id: string, domain: string | null) => ({
  domain,
  id,
  name: id,
  serverName: "vps-1",
  status: "running",
});

const ids = (edges: { source: string; target: string }[]) =>
  edges.map((e) => `${e.source}->${e.target}`).toSorted();

await runVerify("environment topology (the drawn graph)", () => {
  {
    const { edges, nodes } = buildTopology(
      scope({
        databases: [database("db")],
        services: [service("api", 1), service("worker", 0)],
      }),
      [{ from: "api", to: "db", toKind: "database" }]
    );

    check(
      "a published service is reached from the internet",
      ids(edges).includes(`${INTERNET_NODE_ID}->api`)
    );
    check(
      "a service with no domain is NOT",
      !ids(edges).includes(`${INTERNET_NODE_ID}->worker`)
    );
    check("a declared dependency is drawn", ids(edges).includes("api->db"));
    check(
      "every resource is a node, edges or not — nothing is hidden",
      nodes.filter((n) => n.id !== INTERNET_NODE_ID).length === 3
    );
  }

  {
    const { nodes } = buildTopology(
      scope({ databases: [database("db")], services: [service("api", 0)] }),
      []
    );
    check(
      "no internet node when nothing is published",
      !nodes.some((n) => n.id === INTERNET_NODE_ID)
    );
  }

  {
    const { edges } = buildTopology(
      scope({ stacks: [stack("web", "shop.test"), stack("jobs", null)] }),
      []
    );
    check(
      "a stack that publishes a domain is reached too",
      ids(edges).join(",") === `${INTERNET_NODE_ID}->web`
    );
  }

  {
    // The server already scopes both ends; an edge that names something not
    // on this canvas is a bug, and a dangling line would draw it as fact.
    const { edges } = buildTopology(scope({ services: [service("api", 0)] }), [
      { from: "api", to: "elsewhere", toKind: "database" },
      { from: "ghost", to: "api", toKind: "service" },
    ]);
    check("an edge with an unknown end is dropped", edges.length === 0);
  }

  {
    const { edges } = buildTopology(
      scope({ services: [service("web", 0), service("api", 0)] }),
      [{ from: "web", to: "api", toKind: "service" }]
    );
    check(
      "a service can depend on another service",
      ids(edges).join(",") === "web->api"
    );
  }

  {
    const { nodes } = buildTopology(
      scope({ databases: [database("db")], services: [service("api", 1)] }),
      []
    );
    const target = nodes.find((n) => n.id === "db")?.data.target;
    check(
      "a node carries the three params its detail route needs",
      target?.environmentId === ENVIRONMENT &&
        target?.projectId === PROJECT &&
        target?.resource === "databases" &&
        target?.id === "db"
    );
    check(
      "the internet node goes nowhere",
      nodes.find((n) => n.id === INTERNET_NODE_ID)?.data.target === null
    );
  }
});
