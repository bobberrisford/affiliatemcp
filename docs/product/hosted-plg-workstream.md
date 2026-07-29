# Hosted PLG workstream brief

> Status: working brief for the multi-PR feature. Companion to the roadmap in
> `~/.claude/plans/now-that-we-have-agile-wave.md`. Voice: matter-of-fact,
> UK English.

## User outcome

A hosted user gets daily value from automated affiliate work, that value comes
out as a branded, screenshot-ready card they post to LinkedIn, and the post
pulls the next user in. One polished, shareable workflow ships per week,
alternating publisher and agency.

## Why now

The hosted service is live (`mcp.agenticaffiliate.ai`, OAuth connector, vault,
Stripe, a weekly digest cron) and a free-first metered tier is accepted and
mid-build. The automation backbone exists; what is missing is (a) a shareable
artifact for every report and (b) a weekly launch cadence. See the roadmap for
the full growth-loop rationale.

## Decisions taken

- **Cohort:** alternate publisher / agency weekly.
- **Monetisation:** free-first — artifacts and daily automations are free and
  unmetered (they are the viral engine); premium is operation / scale /
  assurance / seats / export.
- **Delivery:** in-chat branded artifact + email digest (no Slack for now).
- **Attribution:** the "made with agenticaffiliate.ai" footer on shared cards is
  approved.

## Dependency graph

```
F1 artifact renderer ──▶ weekly launches W1..W12 (each: skill → artifact → post)
F2 digest framework  ──▶ scheduled digests (W4 anomaly alert onward)
benchmark decision (PR #403, Proposed) ──▶ benchmark artifact (gated week)
```

- **F1 — artifact renderer.** In-chat card format, no new data egress. Routine.
  First proof shipped as design assets: `earnings-card-square` (W1),
  `qbr-scorecard-square` (W2) under
  `.claude/skills/affiliate-mcp-design/ui_kits/social/`.
- **F2 — digest-type framework.** Generalise the single weekly earnings digest
  into configurable digest types × cadence on the existing cron. Reuses
  `hosted/src/digest.ts`, `src/hosted-digest/`, the Worker cron, Resend. Stays
  inside `docs/decisions/2026-07-12-hosted-credential-custody.md`; any new
  cadence/scope is confirmed against that record.

## Owning domains

- Artifact renderer + weekly cards: design system + skill output layer.
- Digest framework: hosted Worker + Node digest service (risk-class: touches
  hosted transport/egress; needs Rob's merge approval).
- Gating/metering: `src/hosted-transport/tier-gate.ts`, `entitlement-client.ts`.
- Launch copy: `affiliate-mcp-marketing`.

## Risk gates

- **Benchmarks** ("vs category median") — gated on decision PR #403; no
  implementation until accepted.
- **Team tier (£299)** — unimplemented in `tier-gate.ts`; needs a tenancy/seats
  decision before build.
- **New scheduled auto-actions** — bounded by the action-authority layer; each
  needs its own record.
- Any digest scope/cadence change re-confirmed against the custody contract.

## Acceptance proof per PR

- **F1 / each weekly card:** render via the hosted connector against a real
  configured network; capture the PNG; confirm brand + attribution + one focal
  number; free/metered gate behaves (free metered, paid uncapped).
- **F2:** trigger a digest compose for the seeded test tenant
  (`2026-07-18-hosted-seeded-test-tenant.md`); confirm the email lands via Resend
  within the custody contract.
- **Launch post:** passes the `affiliate-mcp-marketing` ship-checks.

## Stop conditions

- Do not build any gated bet before its decision record is accepted.
- Respect the WIP lanes: one active-risk PR at a time (F2 and later hosted code
  is the risk lane), at most two routine PRs (weekly cards).
- Never merge without Rob's explicit yes on the specific PR. Never publish or
  post; prepare and hand to Rob.

## Landing order

1. Benchmark decision PR (#403) — unblocks the gated hook.
2. F1 renderer + W1 earnings card (design assets shipped; wire into hosted
   output as the first real consumer).
3. F2 digest framework with W4 scheduled anomaly alert as its first consumer.
4. Weekly vertical slices W2..W12, alternating cohort, each independently
   coherent.
5. Integration proof: a full "connect → report → shareable card → digest" run
   through the hosted connector.

## Automation

A Monday 09:00 scheduled routine (`weekly-hosted-plg-launch`) prepares each
week's artifact + post as a draft PR and hands it to Rob. It never merges or
posts.
