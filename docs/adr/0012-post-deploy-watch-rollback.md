# Post-deploy watch and Noddle-owned rollback

Swarm's safety net expires with `--update-monitor`. Past that window a late crash
relaunches the broken image forever. **Noddle keeps watching after deploy
"success"** and rolls back from its own deployment history — Swarm only retains
one previous spec; Noddle can return to any previous image. Ship with the deploy
loop, not as a later nicety.

**Status:** accepted
