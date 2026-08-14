# Default environment is undeletable

`/projects/<id>` always redirects to an environment. A project whose last
environment has been deleted therefore 404s on a row that still exists.

We follow Dokploy: a project is born with one **default environment**
(named `production`). It cannot be deleted or renamed. Extra environments
can, while empty. An empty-project page was the other option; it would make
the redirect route a real screen, for a state the product does not want.

**Status:** accepted
