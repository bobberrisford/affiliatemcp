# Hosted Worker deploy: on push to main (regular pipeline) + manual dispatch

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

We want the hosted Worker deployed the same way the site is — as part of the
regular pipeline, on merge to `main`, so no one has to remember a manual step
(Rob's call: it should be in the regular deployment pipeline). The billing and
entitlement surface still deserves guard rails, so the automation is
path-scoped and test-gated rather than unconditional.

## Decision

Add `deploy-hosted.yml`, part of the regular pipeline:

- **Runs on push to `main`** when `hosted/**` (or the workflow itself) changes,
  mirroring `deploy-pages.yml`. Also runnable manually via `workflow_dispatch`.
- The manual path requires a typed `confirm: deploy` input; the push path does
  not (there is no input to type on an automatic run).
- Gates on `npm --prefix hosted test` before deploying — a failing hosted test
  blocks the deploy.
- Injects config from Actions variables and fails fast if any placeholder
  survives, so a template config can never reach production.
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

- **Manual-only (`workflow_dispatch`, no push trigger).** The first draft of
  this record. Rejected in favour of the regular pipeline: it still relies on
  someone remembering to run the deploy after a merge (exactly how #380 shipped
  to `main` without going live). The push trigger is scoped to `hosted/**` and
  gated on the hosted tests, and `wrangler rollback` is the undo, so the
  residual risk of auto-deploying the billing surface is accepted.
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
