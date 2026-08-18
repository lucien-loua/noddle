# Service dependencies are declared, not inferred

Noddle's model was a tree: an environment owns services, databases and stacks, each pinned to a server. The one relation users actually draw on a whiteboard — _this app talks to that Postgres_ — existed nowhere. It lived inside a `DATABASE_URL`, encrypted at rest, and `attachDatabase` **knew** it at the moment of the click and threw it away.

So the edge is **stored** (`service_dependencies`), written when a database is attached to a service. Inferring it was the other option and it is worse twice over: reading the graph would mean decrypting every variable of every service on every render, and a parse that guesses wrong fails silently — a topology that lies is worse than no topology.

The edge is **declarative**. It does not order deploys, and the schema does not refuse cycles: ordering needs cycle detection and an answer to "what happens when the dependency is down", neither of which is decided. It also outlives the variable that created it — deleting `DATABASE_URL` is not the same statement as "this app no longer uses that database". Detaching is.

**Status:** accepted
