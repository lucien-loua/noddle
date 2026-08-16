# Single Swarm manager; others are workers

**One Swarm manager only**; every added server joins as a **WORKER**. `docker service create/update` requires a manager. Staying at one manager also avoids Raft quorum sizing. `role` carries that fact; `isSelf` remains display-only (ADR-0006).

**Status:** accepted
