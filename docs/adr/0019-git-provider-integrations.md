# Git provider integrations: GitHub App and GitLab OAuth, nothing else

The Provider tabs (`github`, `gitlab`, `git`) currently render the **same form**: a repository URL and a branch. The tab only changes a placeholder and the label stored in `source_type`. Nothing connects to a provider, so there is no repository picker, no branch list, and no automatic webhook — the user pastes a URL and configures the hook by hand.

## Decision

A **Git Provider** is a first-class row, `git_providers`, carrying a `provider_type` and a name, with the credentials in a **per-type table** joined one-to-one. A Service points at one, or at none.

**Two provider types, `github` and `gitlab`.** Each provider is a distinct credential model, a distinct API for listing repositories and branches, a distinct webhook payload and a distinct token lifecycle — the shared `git_providers` row is a name and a type, and essentially nothing else is shared. Two are what we can keep working against real APIs.

The per-type split is not ceremony, it is the consequence: the two credentials have nothing in common.

### GitHub — an App, created by the operator

The credential is a GitHub App: app name, app id, client id, client secret, installation id, private key, webhook secret, and the GitHub URL for a self-hosted instance.

The operator creates the App **from their own Noddle instance** through the App manifest flow — not an App shipped centrally with Noddle. Noddle is self-hosted (ADR-0005, ADR-0014), and a single App owned by the project would make every installation depend on credentials we hold, put us in the path of every user's source code, and make us the rate-limit bottleneck.

An App rather than an OAuth App, on GitHub, because it installs against selected repositories, mints **short-lived installation tokens** on demand, survives the person who set it up, and delivers webhooks by construction. There is no long-lived user token at rest.

### GitLab — OAuth with a refresh token

GitLab has no equivalent of a GitHub App, so this one is genuinely OAuth: application id, secret, redirect URI, access token, refresh token, `expires_at`, group name, and the GitLab URL for a self-hosted instance.

That means a **stored access token that expires**, refreshed before use against `/oauth/token` with a safety margin — never lazily on a 401, which would surface as a failed deploy. This asymmetry with GitHub is the price of the platform, not a design we chose; do not "harmonise" the two into shared token columns.

### Secrets

Access token, refresh token, client secret, GitHub private key and webhook secret are all encrypted at rest with `APP_KEY` (AES-256-GCM), like every other secret in the product. None is ever returned by a read path, even encrypted — same rule as `ssh_keys.private_key_encrypted`.

The GitLab clone URL embeds the token (`https://oauth2:<token>@host/...`). It is therefore a **secret that looks like a URL**: it must never be written to a deployment log, stored in `deployments`, or shown in the UI.

## What this does not replace

The **deploy key** (`services.deploy_key_id`) stays. It is the answer for a repository behind no provider integration — a self-hosted Git remote, a mirror, an internal host. A Service authenticates by provider _or_ by deploy key, never both; the Provider tab decides which.

The **webhook secret** stays for the same reason: a service configured by URL still needs a hook it can be given.

`source_type` gains no new value. A Service connected through a provider is distinguished by carrying a `git_provider_id` — the source is still a git clone.

## Sequencing

GitHub first, end to end — connect, pick a repository, pick a branch, deploy, receive the hook. GitLab second, once that path works and the repository picker has a shape worth reusing.

**Status:** accepted
