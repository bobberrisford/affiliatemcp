# Seeded test tenant for automated live authenticated hosted testing

- **Date:** 2026-07-18
- **Status:** Accepted (2026-07-18, Rob); rotation handled by option A
- **Affects:** CI (`.github/workflows/`), `tests/hosted-personas/`, and possibly
  the hosted auth server (`hosted/src/oauth.ts`, `hosted/src/token.ts`) if a
  non-rotating CI credential is chosen
- **Builds on:** [`2026-07-15-hosted-connector-oauth.md`](./2026-07-15-hosted-connector-oauth.md),
  [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)
- **Relates to:** [`2026-07-12-pricing-billing-and-licence.md`](./2026-07-12-pricing-billing-and-licence.md),
  `tests/hosted-personas/README.md` (Tier 3)

## Context

The hosted service is live. Tier 1 (live unauthenticated contract smoke) and
Tier 2 (in-process composition invariant) are covered. Tier 3, a live
**authenticated** end-to-end walk (OAuth session, vault-backed credentials, an
active subscription, a real tool call through the connector), is not automated.
It cannot be driven by a coding agent: it needs a magic-link login, network API
keys pasted into the vault, and a Stripe subscription, all of which are account
creation and credential entry that an agent must not perform.

The question is whether to provision a dedicated **seeded test tenant** whose
credentials live in CI secrets so an automated job can exercise the live
authenticated path, or to leave Tier 3 as a fully manual maintainer runbook.

A standing credential in CI is a security decision, so it needs deliberate
maintainer acceptance before implementation.

## Proposed direction

Provision one **dedicated hosted test tenant**, used only for automated testing,
and add an env/secret-gated automated smoke that reads its credential from a CI
secret. The tenant holds only throwaway data:

- a dedicated test email identity (a hosted user created via the normal
  magic-link flow);
- **test-mode / sandbox** affiliate credentials for one or two hosted-eligible
  networks (never a real revenue account), pasted once into the vault;
- a **Stripe test-mode** subscription (Solo or Pro) so entitlement is `active`.

The automated smoke (`tests/hosted-personas/live-authenticated.test.ts`, gated on
`HOSTED_TEST_REFRESH_TOKEN` being present, skipped otherwise exactly like the
Tier 1 live smoke) does:

1. refresh-token grant against `https://hosted.agenticaffiliate.ai/token` to get
   a short-lived access token;
2. connect an MCP client to `https://mcp.agenticaffiliate.ai/mcp` with that
   bearer;
3. call a read-only tool (`affiliate_list_networks`, plus one vault-backed read
   such as `affiliate_<net>_get_earnings_summary`);
4. assert an entitled success, not a refusal, proving the whole live chain:
   OAuth refresh, transport session verify, entitlement (`active`), vault
   reveal, adapter.

### The refresh-token rotation wrinkle (the crux)

The OAuth server **rotates refresh tokens on use** (the old one stops working;
proven in `hosted/test/oauth.test.ts`, "issues a new access token and rotates
the refresh token"). A refresh token stored statically in a CI secret therefore
breaks after its first run. Two ways to handle this, and the choice is the real
decision:

- **A. Rotate-and-write-back (chosen).** A single scheduled or
  `workflow_dispatch` job, `concurrency: hosted-live-auth` (never parallel),
  exchanges the stored refresh token, runs the smoke, then writes the newly
  rotated refresh token back to the `HOSTED_TEST_REFRESH_TOKEN` secret via the
  GitHub API using a fine-grained PAT scoped to `secrets:write` on this repo
  only. No new hosted auth surface. Fragile only if two runs overlap, which the
  concurrency guard prevents. Never runs on pull requests (so a fork cannot read
  the secret) — only on `push` to `main` or manual dispatch.
- **B. Non-rotating CI service credential.** Add a dedicated long-lived,
  read-only service token to the hosted auth server for this one purpose. Cleaner
  operationally (no write-back), but it is new authentication surface with its
  own threat model and its own decision, and it widens the standing-credential
  blast radius. Not chosen; revisit only if option A proves noisy.

## Rejected alternatives

- **Fully manual Tier 3 runbook only (status quo).** Zero standing credential,
  zero blast radius, but no regression signal on the live authenticated path
  between manual runs. Keep the manual runbook regardless (see below); this
  decision is about adding automation on top, not replacing it.
- **Reuse a real revenue affiliate account as the test tenant.** Rejected: puts
  real earnings data and a real Stripe customer behind a CI secret. The tenant
  must be throwaway and test-mode only.
- **Store an access token instead of a refresh token.** Rejected: access tokens
  are short-lived (1h), so the secret would be perpetually stale.

## Provisioning runbook (maintainer-only; an agent must not perform these)

These are the account-creation and credential-entry steps that only Rob can do.

1. **Create the tenant.** Sign in at `https://hosted.agenticaffiliate.ai` with a
   dedicated test email (e.g. a `+hostedtest` alias). Complete the magic-link
   flow.
2. **Connect a network with sandbox keys.** In the connect dashboard, paste
   **test-mode / sandbox** API keys for one hosted-eligible network (Awin or CJ).
   Never real revenue-account keys.
3. **Subscribe in Stripe test mode.** Start a Solo or Pro subscription using a
   Stripe test card, so `/billing/entitlement` returns `active`.
4. **Capture a refresh token.** Complete an OAuth authorization-code + PKCE
   exchange for this tenant (the connector's own client) and capture the
   `refresh_token` from the token response and the `client_id`.
5. **Set the CI secrets.** `gh secret set HOSTED_TEST_REFRESH_TOKEN` and
   `gh secret set HOSTED_TEST_CLIENT_ID` (and, for option A, a fine-grained
   `HOSTED_TEST_SECRETS_PAT` scoped to this repo's `secrets:write`). Do this
   yourself; do not paste token values into an agent session.
6. **Rotation hygiene.** Plan to re-provision the refresh token if the job is
   paused long enough for it to be revoked, and revoke it immediately (delete the
   tenant, or rotate) if a leak is ever suspected.

## Consequences and implementation follow-ups

- **Public contracts affected:** none for option A (CI + tests only). Option B
  would add a hosted auth surface and require its own decision.
- **Risks and failure modes:** a leaked refresh token grants read access to the
  test tenant only (test-mode Stripe, sandbox affiliate keys, no real revenue
  data). Mitigations: dedicated throwaway tenant; secret masked in Actions;
  job never runs on external PRs; single-concurrency write-back; documented
  revocation. The `oldestUnpaidAgeDays`-style time-derived fields make exact
  output non-deterministic, so the smoke asserts entitled success and shape, not
  byte-equality.
- **Dependent implementation PRs (do not start until this is Accepted):**
  1. `tests/hosted-personas/live-authenticated.test.ts` (env/secret-gated smoke),
  2. a `hosted-live-auth` CI workflow (scheduled / `workflow_dispatch`,
     `concurrency` guard, no-PR trigger, option-A write-back step),
  3. a short "Tier 3" runbook note in `tests/hosted-personas/README.md`.
- **Dependency graph and merge order:** this decision first; then the gated test
  and workflow together; the runbook note with them.
- **Deliberately out of scope:** option B's non-rotating service credential;
  automating steps 1 to 4 of the runbook (they remain maintainer-only); the
  absent custody **export** route (tracked separately).
