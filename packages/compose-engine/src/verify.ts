// bun run packages/compose-engine/src/verify.ts
import { check, expectThrows, runVerify } from "@noddle/testing";
import {
  injectDeployConfig,
  listComposeServiceKeys,
  parseCompose,
} from "./index.ts";

const SAMPLE = `
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
  api:
    build: ./api
`;

await runVerify("compose-engine", () => {
  const doc = parseCompose(SAMPLE, "verify.yml");
  check("parses services", Boolean(doc.services?.web && doc.services?.api));

  const keys = listComposeServiceKeys(SAMPLE);
  check(
    "lists service keys",
    keys.length === 2 && keys.includes("web") && keys.includes("api")
  );

  expectThrows("rejects YAML without services", () =>
    parseCompose("version: '3'\n", "bad.yml")
  );

  injectDeployConfig(doc, {
    builtKeys: ["web", "api"],
    networkName: "noddle",
    placementNodeId: "node-1",
    port: 80,
    publicService: "web",
    stackName: "demo",
  });

  const web = doc.services?.web;
  if (!web) {
    check("web service present after inject", false);
    return;
  }

  const webDeploy = web.deploy as Record<string, unknown> | undefined;
  check(
    "injects update_config on built services",
    Boolean(webDeploy?.update_config)
  );
  check(
    "pins placement when node id given",
    JSON.stringify(webDeploy?.placement).includes("node.id==node-1")
  );
  check(
    "attaches public service to overlay network",
    Array.isArray(web.networks) && web.networks.includes("noddle")
  );
  check(
    "marks overlay network external",
    Boolean(
      (doc.networks?.noddle as { external?: boolean } | undefined)?.external
    )
  );
});
