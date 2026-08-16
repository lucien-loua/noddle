# Local Multipass topology (not DinD)

Development targets are **local Multipass VMs** over real SSH — not Docker-in-Docker and not OrbStack (evaluated, works, dropped to keep one path). VMs stay at **2 GB RAM on purpose** so build-cap OOMs are reproducible. Hostnames use `sslip.io`. TLS/ACME needs a public domain or Pebble.

**Status:** accepted
