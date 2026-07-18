# Hosted persona testing

Persona coverage for the hosted connect + billing layer, in three tiers. Most of
the hosted journeys are already proven by the Worker and transport suites; this
directory adds the two things those suites do not cover — a **live** contract
check and the **direct-vs-hosted composition invariant** — and maps where
everything else is proven, so the coverage is legible rather than duplicated.

## Tier 1 — live contract smoke (`live-smoke.test.ts`)

Opt-in (`HOSTED_LIVE_SMOKE=1`), hits the real deployed endpoints, no auth. Proves
the live service still presents the correct discovery/challenge contract:

```
HOSTED_LIVE_SMOKE=1 npm test -- tests/hosted-personas/live-smoke.test.ts
```

Ordinary `npm test` / CI skip it, so the offline suite stays deterministic.

## Tier 2 — composition invariant (`composition-invariant.test.ts`)

The hosted path is the local path plus an auth/entitlement/vault wrapper, not a
divergent code path — both end at the same `tool.handle`. This suite proves that
for an entitled, connected, under-cap persona the SAME call yields byte-identical
adapter output directly (env credentials) and through the real hosted transport
(vault credentials), and that hosted mode only ADDS refusals (an unentitled
persona is refused before the adapter runs, while the identical direct call still
returns data).

## Tier 2 — where the rest is already proven (no duplication)

The persona journeys below are owned and proven by these existing suites. Persona
testing relies on them rather than re-implementing them:

| Journey | Persona relevance | Proven in |
| --- | --- | --- |
| OAuth 2.1 authorization-code + PKCE S256 (happy, wrong verifier, reused code, refresh rotation, consent deny, open-redirect guard) | any persona signing in | `hosted/test/oauth.test.ts` |
| RFC 9728 protected-resource discovery + `WWW-Authenticate` (401 with/without `resourceUrl`) | any client connecting | `tests/hosted-transport/http-server.test.ts` |
| Vault paste-once (no values echoed), reveal round-trip, never another user's, hard delete across all KV namespaces | connecting a network | `hosted/test/vault-routes.test.ts` |
| Tier gate: `none` refused before any network call, Solo 5-network cap, Pro uncapped, billing outage, rate limit | operator / publisher / agency AM | `tests/hosted-transport/http-server.test.ts`, `tests/hosted-transport/tier-gate.test.ts` |
| Entitlement transitions: `checkout.session.completed` grants, `subscription.deleted` cancels, lapsed→none, idempotent replay, signature tamper/replay guard | subscribe / churn | `hosted/test/billing.test.ts`, `hosted/test/stripe.test.ts` |
| Digest scope: none/solo/pro digest-type gating | scheduled digests | `hosted/test/scope.test.ts`, `hosted/test/billing.test.ts` |

## Tier 3 — live authenticated end-to-end (not automated here)

A full persona walk (magic-link login → paste keys → subscribe → tool call →
cap/refusal → cancel → delete) needs a real login, real network keys, and a real
Stripe-test subscription. It cannot be driven by an agent (account creation and
credential entry are out of bounds) and is not in ordinary CI. It belongs in a
maintainer-run runbook against a dedicated test tenant; provisioning a seeded
test tenant to automate a subset is an open decision (plan D1).

## Known gap kept visible

The accepted custody decision names self-serve **export** alongside hard delete,
but `hosted/src/routes/account.ts` implements delete only — there is no export
route yet. This is a real gap, tracked, not silently "green".
