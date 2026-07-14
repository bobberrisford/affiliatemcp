# Hosted MVP workstream brief

> Status: active workstream (started 2026-07-13 under
> [`2026-07-13-build-hosted-without-presell.md`](../decisions/2026-07-13-build-hosted-without-presell.md)).
> This is the multi-PR brief AGENTS.md requires before implementation.
> Bounded by the accepted custody record: bring-your-own-key, read-only,
> encrypted per-user keys decrypted at call time, serving only each key's
> owner. Browser handoffs and write actions stay local-only.

## User outcome

An agency account manager, brand manager, or multi-network publisher signs
in with a browser, connects Awin, CJ, Impact, or Rakuten through a guided
flow, and uses the same tools and workflows from Claude or ChatGPT with no
runtime, no terminal, and no laptop-awake constraint. The first paid-only
capability is the scheduled digest (earnings plus unpaid commissions).

## Dependency graph and slices

Each slice is one PR, `active-risk`, sequential (one at a time per the lane
rules), independent agent review plus green CI before merge, maintainer
authorisation per the standing delivery window or explicit approval.

1. **H1: request-scoped identity seam.** Credential, OAuth-token, brand, and
   client-strategy resolution move behind request-scoped interfaces with the
   local single-user implementation as the default. First real consumer: the
   existing local server running through the seam. Acceptance proof: the
   full existing test suite passes unchanged, plus new seam tests; zero
   behaviour change locally.
2. **H2: hosted service scaffold and user auth.** A new top-level `hosted/`
   workspace following the existing Worker pattern (issuer, telemetry,
   waitlist). Email magic-link sign-in (no passwords), session tokens,
   health and smoke tests, own CI job. Recommended runtime: Cloudflare
   Workers, matching the three existing Workers; the slice PR records the
   trade-offs (adapter fetch portability, CPU limits for large report
   aggregation) and is the point to reverse if Workers prove unfit.
3. **H3: encrypted credential vault.** Per-user envelope encryption (master
   key in Worker secrets, per-user data keys, WebCrypto), decrypt only at
   call time, key-rotation procedure documented, deletion is complete.
   Acceptance proof: vault tests including rotation and hard delete; a
   documented threat model note in the PR.
4. **H4: remote MCP transport.** Streamable HTTP MCP endpoint with per-user
   token auth, per-tier rate limits, and a per-user audit log (network,
   operation, timestamp; never payloads). Adapters untouched; requests run
   through the H1 seam against H3 credentials. Acceptance proof: an MCP
   client end-to-end test against a staging deploy with a test credential.
5. **H5: guided connect flow.** Browser onboarding for the four production
   networks: OAuth where supported, guided paste-once otherwise, connection
   test on save, automatic first-value report. Terms-of-service check per
   network recorded before it is offered hosted.
6. **H6: scheduled digest and billing tie-in.** The digest job runner and
   the Stripe subscription state enforced at the transport boundary,
   reusing the issuer's billing pattern.

Cross-slice docs (trust page, PRIVACY.md hosted section) land with H3 and
H4 respectively, per the custody record's follow-ups.

## Risk gates

- Custody boundaries are non-negotiable slice to slice; any deviation stops
  the workstream for a decision.
- H2's runtime choice and H4's transport are the two highest-reversal-cost
  points; each PR must state what reversing would cost.
- Deploys to any live environment are Rob-only throughout.

## Stop conditions

- Rob pauses or redirects the workstream.
- A slice cannot meet the custody contract without expanding it.
- The H4 end-to-end proof cannot pass against a real MCP client.

## Deliberately excluded

Hosted write actions, browser handoffs, team seats, SOC 2 work, any network
beyond the four production adapters, and every marketing surface change
except repointing the pricing CTA as slices ship.
