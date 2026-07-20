# DRAFT — site trust-copy changes for the benchmark decision

> Status: **draft for Rob's review. Do not publish.** This is the "site-copy
> change" follow-up to the accepted benchmark decision
> (`docs/decisions/2026-07-19-hosted-benchmark-aggregates.md`). It is kept in
> `docs/` (not `site/`) deliberately, because the live site auto-deploys from
> `site/` on merge to `main`, and neither change below should go live yet.

## Why this is a doc, not live-page edits

1. **Benchmarks are not built yet.** The decision is accepted but the feature is
   gated (no implementation until built). Putting "opt-in benchmarks" copy on the
   live site now would advertise a feature that does not exist. The copy below is
   ready to place *when benchmarks ship*.
2. **A larger, pre-existing contradiction needs deciding first (see below).**

## Finding — `site/security.html` already contradicts the live hosted tier

This is bigger than benchmarks and is **live right now**. `site/security.html`
is built around "no hosted service":

- meta description / OG / Twitter: "local-first with **no hosted service**",
  "We never receive your credentials or affiliate data" (lines 7, 12, 21).
- body: "affiliate-mcp is local-first with **no hosted service**" (line 70);
  "There is no hosted service and no account to create with us" (line 77);
  "**No multi-tenant server**, no shared database, no vendor-held copy of your
  data" (line 80); "there is no hosted service or vendor-held data to certify,
  and **we are not a processor of your affiliate data** because it is never sent
  to us" (line 121).

The hosted tier is live (`hosted.agenticaffiliate.ai`, `mcp.agenticaffiliate.ai`,
an encrypted credential vault, Stripe billing). So the security page's core
claim is already inaccurate and is a trust/legal exposure independent of
benchmarks — the project *is* now a processor of hosted users' data for the
hosted tier.

**Recommendation:** treat the security-page repositioning as its own small
decision + PR (how to present the hosted tier's data handling, sub-processors,
and "processor" status honestly, while keeping the local tier's strong
local-first claims). This should land regardless of benchmarks. It is a Rob call
(public trust surface).

## Proposed benchmark copy (place only when benchmarks ship)

For `site/hosted.html` (and mirrored in `site/privacy.html`'s hosted section):

> **Benchmarks are opt-in.** By default your data is used only to serve your own
> reports. If you switch on benchmarks, your figures contribute — anonymously
> and in aggregate only — to category medians you can compare against. We never
> expose any single account's numbers, never share raw transactions or partner
> identities, and you can turn it off at any time.

For the `site/security.html` FAQ (once that page is repositioned for hosted):

> **Do you aggregate customer data?** Only if a hosted customer opts in, and only
> as anonymous, k-anonymous aggregates for programme benchmarks — never
> individual figures, never raw data, never partner or brand identities. Off by
> default and revocable. See our privacy policy.

## Publish checklist (do not tick until approved)

- [ ] Benchmark feature shipped and live.
- [ ] `site/security.html` repositioned for the live hosted tier (separate PR).
- [ ] Rob approves the benchmark copy above.
- [ ] Then, and only then, apply to `site/` and let it deploy.
