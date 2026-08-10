# Resource-capped builds via buildx

Every build is resource-capped through a **capped buildx builder**
(`docker-container` driver opts), not via `docker build --memory` (BuildKit
accepts and ignores those flags). A Next.js build on a 2 GB VPS will otherwise
OOM and take down running production apps.

**Status:** accepted
