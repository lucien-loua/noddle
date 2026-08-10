# Docker Swarm for orchestration

Noddle deploys with **Docker Swarm mode** (single node to start).
`docker service update` is a transactional deploy primitive — rolling update,
health gate and rollback are already correct, including edge cases. Hand-rolling
the swap is forbidden.

**Status:** accepted
