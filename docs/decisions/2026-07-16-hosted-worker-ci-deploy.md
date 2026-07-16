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

Config is split three ways so nothing account-specific is committed to this
public repo and no secret ever reaches CI:

- **Public values committed inline** in `hosted/wrangler.toml`: the URLs
  (`PUBLIC_BASE_URL`, `BILLING_*`, `DIGEST_SERVICE_URL`, `HOSTED_CONNECTOR_URL`)
  and constants (`SITE_ORIGIN`, `VAULT_MASTER_KEY_VERSION`, crons). These are
  already public (they appear in emails, redirects, and client config).
- **Account-specific ids injected at deploy** from repo Actions **variables**
  (non-secret, not committed): the three KV namespace ids and the two Stripe
  **price** ids. The committed toml carries `__…__` placeholders; the workflow
  substitutes them and fails if any variable is unset or any placeholder
  remains.
- **Secrets** (`VAULT_MASTER_KEY`, `SESSION_SIGNING_KEY`, `RESEND_API_KEY`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are set once via
  `wrangler secret put`, persist on the Worker, and are **not** touched by a
  code deploy — CI never holds them.

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
- **Commit the account-specific ids (KV, price) into `wrangler.toml`.**
  Considered — they are not secrets — but rejected to keep account infra ids
  out of a public repo. They are supplied as Actions variables instead.

## Consequences

- CI holds a Cloudflare API token that can edit Workers on the account. Scope
  it to the minimum (Workers Scripts: Edit) and rotate on suspicion.
- The account-specific ids live as repo Actions **variables**, not in the repo.
  Changing a KV namespace or Stripe price means updating the variable, not a
  commit.
- Deploys become one auditable Actions run with the tests as a gate, runnable
  by any maintainer, not just the machine holding the local config.

## Implementation follow-ups

- Repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` and the five
  Actions variables (`HOSTED_USERS_KV_ID`, `HOSTED_VAULT_KV_ID`,
  `HOSTED_BILLING_KV_ID`, `STRIPE_PRICE_ID_SOLO`, `STRIPE_PRICE_ID_PRO`) are
  set from the recovered live config. Rob: sanity-check they are current before
  the first run, since they were recovered from the 2026-07-15 deploy worktree.
- First run should be treated as a verification: after it, connect a network at
  `hosted.agenticaffiliate.ai/connect` and confirm the success page shows
  `https://mcp.agenticaffiliate.ai/mcp` and the digest cron still has its
  service URL.
- Fold this deploy path into `DEPLOY.md` so the hosted Worker has a documented
  release runbook alongside the npm and desktop channels.
