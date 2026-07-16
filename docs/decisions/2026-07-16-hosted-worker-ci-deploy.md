# Hosted Worker deploy: gated `workflow_dispatch`, not push-triggered

- **Date:** 2026-07-16
- **Status:** Proposed (awaiting Rob)
- **Affects:** `.github/workflows/deploy-hosted.yml` (new), `hosted/wrangler.toml`
  (must hold real non-secret config to deploy), and the release story in
  `DEPLOY.md` / `docs/product/hosted-oauth-ship-runbook.md`
- **Relates to:** [`2026-07-15-hosted-connector-oauth.md`](./2026-07-15-hosted-connector-oauth.md),
  [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)

## Context

The hosted connect/auth/billing/digest Worker (`affiliate-mcp-hosted`,
`hosted.agenticaffiliate.ai`) had no CI deploy. `ci.yml`'s `hosted` job only
typechecks, tests, and runs a `wrangler --dry-run` build; `publish.yml` is
npm-only and version-gated; `deploy-pages.yml` is the static site. So every
change to the hosted Worker went live only via a manual `wrangler deploy` from
a maintainer's machine. That is easy to forget after a merge (it just happened:
PR #380 merged to `main` but did not deploy), and it ties deploys to one
machine's local `wrangler.toml` and login.

We want a repeatable, auditable deploy that any maintainer can run — without
turning the production **billing and entitlement** surface into something that
ships automatically on every merge.

## Decision

Add a **`workflow_dispatch`-only** workflow, `deploy-hosted.yml`:

- Manual trigger only. It is **not** run on push/merge. A deploy of the money
  path is a deliberate human action.
- Requires a typed `confirm: deploy` input (a second, explicit gate against an
  accidental click).
- Gates on `npm --prefix hosted test` before deploying.
- Fails fast if `hosted/wrangler.toml` still contains `REPLACE_WITH_*`
  placeholders, so a template config can never reach production.
- Authenticates with repo secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, and runs the hosted package's own `deploy` script
  (`wrangler deploy`).

Non-secret configuration (KV namespace ids, Stripe **price** ids, public URLs,
`HOSTED_CONNECTOR_URL`) lives in the committed `hosted/wrangler.toml`. Actual
secrets (`VAULT_MASTER_KEY`, `SESSION_SIGNING_KEY`, `RESEND_API_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are set once via
`wrangler secret put`, persist on the Worker, and are **not** touched by a code
deploy — CI never holds them.

## Rejected alternatives

- **Auto-deploy on push to `main`.** Simplest, but CI would then push to the
  live billing/entitlement Worker unattended on every hosted change. For a
  payment surface the blast radius of a bad auto-deploy is too high; a manual
  gate is worth the friction.
- **Keep it fully manual (local `wrangler deploy`).** The status quo. Rejected:
  not repeatable, tied to one machine's login and local config, and easy to
  forget after a merge.
- **Put all config, including secrets, in CI.** Rejected: secrets already live
  on the Worker and persist across deploys, so CI does not need them; keeping
  them out of CI shrinks the credential's blast radius (custody principle,
  `2026-07-12-hosted-credential-custody.md`).

## Consequences

- CI holds a Cloudflare API token that can edit Workers on the account. Scope
  it to the minimum (Workers Scripts: Edit) and rotate on suspicion.
- The committed `wrangler.toml` must carry the real non-secret ids. These are
  not secrets, but if committing infra ids to a public repo is unwanted, the
  follow-up below is the alternative.
- Deploys become one auditable Actions run with the tests as a gate, runnable
  by any maintainer, not just the machine holding the local config.

## Implementation follow-ups

- Rob: create the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets
  and fill the real values into `hosted/wrangler.toml`.
- If committing infra ids is unwanted, switch to injecting them at deploy time
  from GitHub Actions **variables** (non-secret) rather than committing them,
  and drop the placeholder guard in favour of a substitution step.
- Fold this deploy path into `DEPLOY.md` so the hosted Worker has a documented
  release runbook alongside the npm and desktop channels.
