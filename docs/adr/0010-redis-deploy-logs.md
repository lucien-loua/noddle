# Redis for worker → web deploy logs

Live deploy logs cross the worker/web process boundary via **Redis pub/sub**, a capped list for catch-up, and a file for archive. The `onLog` callback does not cross that boundary. Tail-following the file from the web would put live delivery on inotify across a bind mount between Node writing and Bun reading — the class of third-party interaction that caused every breakage. Redis is already there for BullMQ.

**Status:** accepted
