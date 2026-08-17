// tier: pure
// bun run packages/proxy-config/src/verify.ts
import { check, expectThrows, runVerify } from "@noddle/testing";

import {
  hostRule,
  routeLabels,
  serviceRouteLabels,
  staleRouteLabelKeys,
  toLabelArgs,
} from "./index.ts";

await runVerify("proxy-config", () => {
  check(
    "hostRule: single domain",
    hostRule(["app.example.com"]) === "Host(`app.example.com`)"
  );
  check(
    "hostRule: multiple domains joined with OR",
    hostRule(["a.example.com", "b.example.com"]) ===
      "Host(`a.example.com`) || Host(`b.example.com`)"
  );
  check("hostRule: empty list yields empty rule", hostRule([]) === "");

  expectThrows(
    "hostRule: rejects unsafe characters in domain",
    () => hostRule(["evil`host.com"]),
    (e) => e instanceof Error && e.message.includes("invalid domain")
  );

  const disabled = routeLabels({
    port: 3000,
    serviceName: "web",
  });
  check(
    "routeLabels: no domains disables Traefik",
    disabled["traefik.enable"] === "false"
  );

  const plain = routeLabels({
    domains: ["app.example.com"],
    port: 8080,
    serviceName: "api",
  });
  check(
    "routeLabels: exposes service on port",
    plain["traefik.enable"] === "true"
  );
  check(
    "routeLabels: sets host rule",
    plain["traefik.http.routers.api.rule"] === "Host(`app.example.com`)"
  );
  check(
    "routeLabels: default entrypoint is web without cert resolver",
    plain["traefik.http.routers.api.entrypoints"] === "web"
  );

  const tls = routeLabels({
    certResolver: "letsencrypt",
    domains: ["secure.example.com"],
    port: 443,
    serviceName: "secure",
  });
  check(
    "routeLabels: cert resolver enables TLS labels",
    tls["traefik.http.routers.secure.tls"] === "true" &&
      tls["traefik.http.routers.secure.tls.certresolver"] === "letsencrypt"
  );
  check(
    "routeLabels: cert resolver defaults entrypoint to websecure",
    tls["traefik.http.routers.secure.entrypoints"] === "websecure"
  );

  const multiDomain = serviceRouteLabels({
    domains: [
      {
        certificateType: "none",
        host: "cdn.example.com",
        https: false,
        path: "/assets",
        stripPath: true,
      },
    ],
    port: 3000,
    serviceName: "static",
  });
  check(
    "serviceRouteLabels: stripPath middleware attached",
    multiDomain[
      "traefik.http.middlewares.static-d0-strip.stripprefix.prefixes"
    ] === "/assets"
  );
  check(
    "serviceRouteLabels: path prefix in router rule",
    multiDomain["traefik.http.routers.static-d0.rule"] ===
      "Host(`cdn.example.com`) && PathPrefix(`/assets`)"
  );

  const httpsDomain = serviceRouteLabels({
    certResolver: "letsencrypt",
    domains: [
      {
        certificateType: "letsencrypt",
        host: "app.example.com",
        https: true,
        path: "/",
        stripPath: false,
      },
    ],
    port: 3000,
    serviceName: "app",
  });
  check(
    "serviceRouteLabels: HTTPS uses websecure entrypoint",
    httpsDomain["traefik.http.routers.app-d0.entrypoints"] === "websecure"
  );
  check(
    "serviceRouteLabels: Let's Encrypt attaches cert resolver",
    httpsDomain["traefik.http.routers.app-d0.tls.certresolver"] ===
      "letsencrypt"
  );

  const stale = staleRouteLabelKeys("svc");
  check(
    "staleRouteLabelKeys: includes legacy and per-domain routers",
    stale.includes("traefik.http.routers.svc.rule") &&
      stale.includes("traefik.http.routers.svc-d0.rule") &&
      stale.includes(
        "traefik.http.middlewares.svc-d0-strip.stripprefix.prefixes"
      )
  );

  check(
    "toLabelArgs: docker --label form",
    toLabelArgs({ "traefik.enable": "true" }).join(",") ===
      "traefik.enable=true"
  );
});
