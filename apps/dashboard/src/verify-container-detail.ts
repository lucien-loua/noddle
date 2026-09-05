// tier: pure
import { readFileSync } from "node:fs";
import path from "node:path";

import { BUILDKIT_CONTAINER } from "@noddle/shared/noddle-containers";
import { check, runVerify } from "@noddle/testing";

import {
  classify,
  parseInspect,
  parsePs,
  PS_FIELDS,
  PS_FORMAT,
} from "@/lib/container-read.server";

const WEB_SRC = path.join(import.meta.dirname);
const SERVER = "server1";

function psLine(fields: string[]): string {
  return fields.join("\t");
}

const INSPECT = JSON.stringify({
  Args: ["postgres"],
  Config: {
    Env: ["PATH=/usr/local/bin", "POSTGRES_PASSWORD=s3cr3t-value"],
    Image: "postgres:18",
    Labels: { "com.docker.swarm.service.name": "pj-test-hejg5w" },
  },
  Created: "2026-08-14T10:59:50.123456789Z",
  HostConfig: { RestartPolicy: { MaximumRetryCount: 0, Name: "" } },
  Id: "3115b0f8f67b2c5e2b2c2e6a0a9a1f5f4c8d7b6a5e4d3c2b1a0f9e8d7c6b5a49",
  Mounts: [
    {
      Destination: "/var/lib/postgresql/18/docker",
      Mode: "z",
      Name: "pj-test-hejg5w-data",
      Propagation: "",
      RW: true,
      Source: "/var/lib/docker/volumes/pj-test-hejg5w-data/_data",
      Type: "volume",
    },
    {
      Destination: "/etc/hosts",
      Mode: "ro",
      RW: false,
      Source: "/host/etc/hosts",
      Type: "bind",
    },
  ],
  Name: "/pj-test-hejg5w.1.ausfaebqcnsf9mpsvx5g0xrzq",
  NetworkSettings: {
    Networks: {
      "noddle-network": {
        Aliases: ["pj-test"],
        Gateway: "10.0.1.1",
        IPAddress: "10.0.1.12",
        IPPrefixLen: 24,
        MacAddress: "02:42:0a:00:01:0c",
      },
    },
    Ports: {
      "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }],
      "9187/tcp": null,
    },
  },
  Path: "docker-entrypoint.sh",
  State: { Health: { Status: "healthy" }, Running: true, Status: "running" },
});

await runVerify("container detail (ps + inspect parsing)", () => {
  check(
    "PS_FORMAT emits exactly PS_FIELDS values",
    PS_FORMAT.split("{{").length - 1 === PS_FIELDS
  );

  const rows = parsePs(
    psLine([
      "3115b0f8f67b",
      "pj-test-hejg5w.1.ausfaebq",
      "postgres:18",
      "running",
      "Up 6 days",
      "0.0.0.0:5432->5432/tcp",
      "pj-test-hejg5w",
      "",
    ]),
    { id: SERVER, name: "vps-1" }
  );
  check("a full line parses", rows.length === 1);
  check(
    "the port summary is kept whole",
    rows[0]?.ports === "0.0.0.0:5432->5432/tcp"
  );
  check("a Swarm label makes it a task", rows[0]?.kind === "swarm");
  check(
    "the service name is carried",
    rows[0]?.serviceName === "pj-test-hejg5w"
  );

  const stale = parsePs(
    psLine(["id", "name", "img", "running", "Up", "", ""]),
    { id: SERVER, name: "vps-1" }
  );
  check("a line with the old field count is ignored", stale.length === 0);

  check(
    "Noddle's own compose project is control plane",
    classify({
      composeProject: "noddle",
      name: "noddle-dashboard-1",
      swarmService: "",
    }) === "control-plane"
  );
  check(
    "the capped build daemon is control plane despite empty labels",
    classify({
      composeProject: "",
      name: BUILDKIT_CONTAINER,
      swarmService: "",
    }) === "control-plane"
  );
  check(
    "the pre-railpack builder is still protected",
    classify({
      composeProject: "",
      name: "buildx_buildkit_noddle-builder0",
      swarmService: "",
    }) === "control-plane"
  );

  const detail = parseInspect(INSPECT);
  check("the name loses Docker's leading slash", detail.name.startsWith("pj-"));
  check(
    "the command joins Path and Args",
    detail.command === "docker-entrypoint.sh postgres"
  );
  check(
    "an empty restart policy reads as Docker's own 'no'",
    detail.restartPolicy === "no"
  );
  check(
    "health is carried when the image declares one",
    detail.health === "healthy"
  );

  check(
    "a named volume shows its name",
    detail.mounts[0]?.source === "pj-test-hejg5w-data"
  );
  check(
    "a read-only bind is reported as such",
    detail.mounts[1]?.readWrite === false
  );

  check(
    "the address carries its prefix",
    detail.networks[0]?.ipAddress === "10.0.1.12/24"
  );
  check("aliases survive", detail.networks[0]?.aliases[0] === "pj-test");

  const published = detail.ports.find((p) => p.containerPort === "5432/tcp");
  const exposed = detail.ports.find((p) => p.containerPort === "9187/tcp");
  check(
    "a published port names its host binding",
    published?.published === "0.0.0.0:5432"
  );
  check(
    "an exposed but unpublished port is not invented",
    exposed?.published === null
  );

  check(
    "environment NAMES are returned",
    detail.envNames.includes("POSTGRES_PASSWORD")
  );
  check(
    "no environment VALUE leaves the server",
    !JSON.stringify(detail).includes("s3cr3t-value")
  );

  const terminal = readFileSync(
    path.join(WEB_SRC, "lib/terminal.server.ts"),
    "utf-8"
  );
  check(
    "the terminal re-reads the kind before exec",
    terminal.includes('from "@/lib/container-read.server"') &&
      terminal.includes("readKind(ssh, containerId)")
  );
  check(
    "the terminal refuses a shell into Noddle itself",
    terminal.includes('found.kind === "control-plane"')
  );
});
