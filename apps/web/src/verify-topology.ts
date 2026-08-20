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
  domains: Array.from({ length: domains }, (_, i) => ({
    host: `${id}-${i}`,
    https: true,
  })),
  id,
  name: id,
  port: 3000,
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
  port: 8080,
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
      "the two kinds of edge are told apart on the canvas",
      edges.find((e) => e.id === "ingress-api")?.data?.dashed === true &&
        edges.find((e) => e.id === "dep-api-db")?.data?.dashed === false
    );
    check(
      "the internet node states how much it reaches",
      nodes.find((n) => n.id === INTERNET_NODE_ID)?.data.reaches === 1
    );
    check(
      "an ingress edge carries what Traefik does with the request",
      edges.find((e) => e.id === "ingress-api")?.data?.label === "HTTPS :3000"
    );
    check(
      "a published service's host is a REACHABLE url, scheme and all",
      nodes.find((n) => n.id === "api")?.data.addressUrl === "https://api-0"
    );
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
    check(
      "a stack states its port and CLAIMS NO SCHEME — it records none",
      edges.find((e) => e.id === "ingress-web")?.data?.label === ":8080"
    );
    check(
      "and its host stays TEXT, for want of a scheme to link with",
      buildTopology(
        scope({ stacks: [stack("web", "shop.test")] }),
        []
      ).nodes.find((n) => n.id === "web")?.data.addressUrl === null
    );
  }

  {
    // The open slot is an invitation, and an invitation you cannot accept is
    // worse than none: it needs the permission AND something to attach.
    const unconsumed = scope({
      databases: [database("db")],
      services: [service("api", 0)],
    });

    check(
      "no attach slot without the permission",
      !buildTopology(unconsumed, []).nodes.some((n) => n.data.kind === "attach")
    );

    const offered = buildTopology(unconsumed, [], { canAttach: true });
    const slot = offered.nodes.find((n) => n.data.kind === "attach");
    check(
      "a database nothing consumes offers to be attached",
      slot?.data.attachTo === "db" && slot.id === "attach-db"
    );
    check(
      "the slot points AT the database, and is marked a ghost so the empty state still counts",
      offered.edges.some(
        (e) =>
          e.target === "db" && e.source === slot?.id && e.data?.ghost === true
      )
    );
    check(
      "no slot on a database that IS consumed",
      !buildTopology(
        unconsumed,
        [{ from: "api", to: "db", toKind: "database" }],
        { canAttach: true }
      ).nodes.some((n) => n.data.kind === "attach")
    );
    check(
      "no slot when there is no service to attach",
      !buildTopology(scope({ databases: [database("db")] }), [], {
        canAttach: true,
      }).nodes.some((n) => n.data.kind === "attach")
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
      scope({
        databases: [database("db")],
        services: [service("api", 1), service("worker", 0)],
      }),
      [{ from: "api", to: "db", toKind: "database" }]
    );
    const at = (id: string) => nodes.find((n) => n.id === id)?.data;

    check(
      "the internet node has a source handle and no target",
      at(INTERNET_NODE_ID)?.hasSource === true &&
        at(INTERNET_NODE_ID)?.hasTarget === false
    );
    check(
      "a consumed database has a target handle and no source",
      at("db")?.hasTarget === true && at("db")?.hasSource === false
    );
    check(
      "a running service has a container to look into",
      at("api")?.live === true
    );
    check(
      "the internet boundary has none — it is not a container",
      at(INTERNET_NODE_ID)?.live === false
    );
    check(
      "a service nothing touches has NO handle at all",
      at("worker")?.hasSource === false && at("worker")?.hasTarget === false
    );
  }

  {
    const deploying = { ...service("api", 1), status: "deploying" };
    check(
      "a service still deploying offers nothing to open",
      buildTopology(scope({ services: [deploying] }), []).nodes.find(
        (n) => n.id === "api"
      )?.data.live === false
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
