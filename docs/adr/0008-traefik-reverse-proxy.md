# Traefik as reverse proxy

The reverse proxy is **Traefik** with the Swarm provider — dynamic label-based routing and native Let's Encrypt. Labels live on the Swarm **service**, not the container; `loadbalancer.server.port` is required. Traefik is pinned ≥ 3.6 for Docker Engine 29 API compatibility.

**Status:** accepted
