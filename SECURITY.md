# Security Policy

Noddle handles SSH keys, database credentials, and webhook secrets for the servers it manages. Taking a report seriously here means taking it seriously before the repository has any users, not after.

## Supported versions

Pre-release: there is no tagged release yet, and only the `main` branch is supported. Once releases start, this section will name which lines still receive fixes.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private vulnerability reporting instead: go to the **Security** tab of this repository and select **Report a vulnerability**. That opens a private advisory visible only to the maintainer and to you until it's resolved.

If that isn't available to you for some reason, open an issue asking for a private contact channel — don't post details in it.

Include what you can:

- what the vulnerability is and where it lives (file, endpoint, or flow)
- steps to reproduce, or a proof of concept
- what you think the impact is — credential exposure, privilege escalation, remote code execution on a managed server, and so on

## What to expect

This is a solo-maintained project. There's no SLA, but reports get looked at, not filed away — expect an acknowledgement within a few days and honesty about timeline once the issue is understood. Credit is given in the fix's commit or release notes unless you'd rather stay unnamed.

## Scope notes specific to this project

Noddle's threat model is unusual for a web app: a compromise here can mean SSH access to every server it manages, not just to the dashboard's own database. A few things worth knowing before you report, so you're not describing something already accounted for:

- SSH keys, env var values, and webhook URLs are encrypted at rest with AES-256-GCM, derived from an app-level `APP_KEY` — not stored or logged in plaintext.
- Secrets are passed to containers as `docker secret` where possible, specifically so they don't leak through `docker inspect`.
- The worker never infers a deploy's success from a process exit code, precisely because a misread there could make a broken or rolled-back deploy look green in the audit trail.

None of that means those areas are out of scope — if you find a way through them, that's exactly the kind of report this policy exists for. It just means "the value isn't encrypted" or "the exit code is trusted" aren't unknown gaps; a report that shows _how_ one of those breaks is worth far more than one that restates the design.

## Safe harbor

Good-faith security research against this project is welcome. If you keep to the reporting process above, don't access or modify data beyond what's needed to demonstrate the issue, and give us a reasonable window to fix it before any public disclosure, we won't pursue or support legal action over your research.
