---
name: programme-health-check
description: |
  Use this skill for a one-off diagnostic across every available data operation for a brand, typically at account handover or kick-off: is the connection healthy, what can we actually read, is data flowing, and where are the gaps. It is the "audit the account before we start" pass, not a recurring report.
  Trigger on: "Audit Acme's programme", "Health-check the Acme account", "Run a full check on [brand]", "We just won Acme, what can we see?", "Is the Acme connection working end to end?".
---

# Operating instructions

You are running a one-off health check on a brand's programme: confirm the
connection works, map what each bound network can read, exercise every supported
read operation once, and report data presence and gaps. This is a handover or
kick-off diagnostic. For the recurring "how is the brand doing" view use
`programme-performance-report`; for the week-over-week scan use
`programme-anomaly-watch`.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — confirm the connection and read capabilities

For the brand's bindings, confirm health and capability before pulling data:

- Call `affiliate_run_diagnostic` for the configured networks, or
  `affiliate_<network>_verify_auth` per binding, to confirm credentials work.
  Awin advertiser: `affiliate_awin-advertiser_verify_auth`.
- Call `affiliate_list_networks` once and retain each binding's supported
  operations, `claimStatus`, and `knownLimitations`.

If auth fails for a binding, record it as a red flag and skip that binding's
data pulls; do not retry around a failed credential.

## Step 3 — exercise each supported read operation once

For every binding, call each operation the network actually supports, once, over
a recent window (default last 30 days, ending today). Skip operations the
network does not support and record them as "not supported" rather than calling
them. Tool names follow `affiliate_<network>_<operation>`:

- Programmes: `affiliate_awin-advertiser_list_programmes({ brand })`
- Per-publisher performance: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to })`
- Roster: `affiliate_awin-advertiser_list_media_partners({ brand })`
- Transactions (where supported): `affiliate_awin-advertiser_list_transactions({ brand, from, to })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. For each
call record three outcomes: it succeeded with data, it succeeded but returned
nothing, or it failed (capture the verbatim envelope: network, operation,
message, httpStatus). A success with no rows is a finding, not a failure.

## Step 4 — present the health check

Output in this order, per network binding:

1. **Connection**: auth result and the network's `claimStatus`
   (production / partial / experimental / unsupported).
2. **Capability matrix**: each operation marked supported or not supported, and
   for supported ones whether the call returned data, returned empty, or failed.
3. **Data presence**: a one-line note per successful operation — programme
   count, partner count by status, recent transaction count, whether any
   performance rows came back. Numbers only where the data shows them.
4. **Known limitations**: surface each binding's `knownLimitations` verbatim
   (for example normalised-zero clicks, missing reversal reasons) so they are
   visible before the account team relies on a metric.
5. **Tracking-link check (manual)**: note that link tracking is not verified by
   this skill. If the operator wants live link verification, point them at the
   shipped `audit-affiliate-links` skill; do not claim this check ran.
6. **Red flags and gaps**: failed auth, unsupported core operations, empty
   results that look wrong for a live programme, and any verbatim errors.

Close with a short plain-language verdict: is the account ready to report on, or
are there gaps to resolve first.

Matter-of-fact tone, UK spelling, no hype. Keep the matrix compact.

## Constraints

- Read-only diagnostic. It never changes configuration or contacts a network
  beyond the read calls above.
- Distinguish "not supported" (the adapter has no such operation) from "empty"
  (the call ran and returned nothing) from "failed" (an error envelope). Never
  collapse these into one state.
- Never invent figures or capabilities. An unsupported operation is reported as
  unsupported, not as zero data.
- Surface `knownLimitations` rather than hiding them; a healthy connection with
  a known metric gap is still a gap the account team must see.
- Do not cite a tracking-link check as having run. Link verification is the
  separate `audit-affiliate-links` workflow.
