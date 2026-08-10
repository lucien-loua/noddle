# Installer registers its own host as target #1

The installer registers its own host as **target server #1** (self host).
Single-box is the common case. One Traefik per host — the installer's *is* the
app Traefik. The local target goes through the SSH executor like any other, so
there is no `localhost` special case and the loopback path is exercised by every
user.

**Status:** accepted
