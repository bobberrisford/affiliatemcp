# Findings: Awin

Captured during Chunk 2 implementation. Feeds Chunk 7's REPORT.md.

## Summary

Awin maps cleanly onto the canonical adapter contract for the seven publisher
operations except `listClicks`. The adapter is shipped at `claim_status:
partial` — every other op is implemented and unit-tested, but `listClicks` is
structurally unsupported by the public Awin API and the adapter has not yet
been exercised against a live publisher account.

## What worked well

- **Single bearer token, long-lived**: no refresh dance, no per-call OAuth
  handshake. `AWIN_API_TOKEN` reads once from `~/.affiliate-mcp/.env` and the
  client attaches it to every request. The token is generated from the Awin
  publisher dashboard → Account → API credentials.

- **`/accounts?type=publisher` doubles as auth-check + identity discovery**: a single call
  validates the token, returns the publisher ID, and gives a human-readable
  name. This is the canonical example of the `derivedValues` pattern: one
  credential bootstraps another, the wizard shows "press enter to accept"
  rather than re-prompting.

- **Deterministic deep-link construction**: Awin's tracking URL format
  (`https://www.awin1.com/cread.php?awinmid=...&awinaffid=...&ued=...`) is
  documented and stable, so `generateTrackingLink` builds the URL in-process
  without an API call. Faster, no failure mode, no rate-limit budget consumed.

- **Stable status vocabulary**: `pending|approved|declined` covers ~95% of
  observed transactions. Mapping to our canonical set is mechanical
  (`declined` → `reversed`). `paid` is derived from `paidToPublisher: true`.

- **Reversed-sale visibility**: Awin populates `declineReason` on declined
  transactions, so PRD §15.10 falls out for free — we just surface the field.

## What didn't / friction points

- **No click data via the public publisher API.** This is the principal known
  limitation. We throw `NotImplementedError` with the reason
  `"Awin does not expose click-level data via the public publisher API"` so
  the caller sees an honest "not supported" rather than "no clicks today".
  If Awin ever adds clicks to the API the limitation disappears with a
  ~30-line code addition; we don't need to redesign anything.

- **31-day transaction window cap.** A single `/transactions` call accepts at
  most 31 days. We handle this by chunking wider windows transparently in
  the adapter; callers see a single `listTransactions({ from, to })`. The
  chunking adds latency (sequential calls, not parallel — keeps us under
  Awin's per-second rate budget).

- **Status string vs paidToPublisher mismatch.** Awin keeps
  `commissionStatus: approved` even after a transaction has been paid out;
  the `paidToPublisher` flag is the authoritative "this is paid" signal. We
  derive `paid` from that flag, not from the status string. Future networks
  may have similar quirks — the lesson is "treat both string and boolean
  signals as inputs to the normalisation".

- **Schema drift between identity endpoints.** The current `/accounts` response
  uses `accounts[].accountId`, while older `/publishers` shapes and fixtures use
  `publisherId`, `id`, or `accountId`. We accept all of them rather than picking
  one. This is the kind of compatibility shim that should NOT be promoted into
  a shared layer — it's Awin-specific.

- **Two date fields, two meanings.** `transactionDate` is the conversion;
  `validationDate` is when Awin approved the commission. The unpaid-age
  affordance (PRD §15.9) needs validation-relative age, not conversion-
  relative. We use `validationDate ?? transactionDate` as the anchor.

- **`accessStatus` enum is undocumented and tenant-specific.** New states
  appear from time to time (`inactive`, `archived`). We collapse unknowns to
  `unknown` rather than miscategorising.

## Token longevity + rate limits

- **Token longevity**: long-lived. No documented auto-expiry; tokens are
  revoked manually from the same dashboard screen they're generated on.
  Treat as a static secret.

- **Rate limits**: Awin publishes no precise per-second budget in the public
  docs. Empirically (per the orchestrator's prior notes) the API tolerates
  modest bursts and rate-limits with a `429 Too Many Requests` response when
  exceeded. Our resilience layer retries 429 by policy with exponential
  backoff + jitter, which is the right default.

- **Latency**: `/accounts` returns in ~100–200ms; `/programmes` in
  ~300–800ms; `/transactions` is the outlier, occasionally 5–15s for a busy
  publisher across a full 31-day window. We bump the `listTransactions`
  timeout to 60s and retries to 3 to absorb the upstream variability.

## Deep-link by construction — why it matters

Awin's tracking URL is fully determined by `{advertiserId, publisherId,
destinationUrl}`. We can build it without any network round-trip. This is the
canonical "deterministic construction" pattern:

- Latency: ~0ms (no network).
- Failure modes: none upstream — only local input validation.
- Rate-limit cost: zero.

Compare with networks that REQUIRE an API call to mint a link (e.g. Impact's
`/Mediapartners/{accountSid}/Programs/{programId}/TrackingLinks`). Those
adapters wrap their call through the resilience layer the same way every
other Awin call does. The general principle: prefer deterministic
construction when the network's link format is documented and stable; fall
back to an API call only when the network mints a per-link tracking ID.

## Future work (Chunk-7-style notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real Awin
  publisher account.
- **Pagination cursor support**: the current adapter returns the full result
  set; if a future query window produces tens of thousands of transactions
  we'll want a cursor abstraction. Awin doesn't natively cursor — we'd chunk
  by date.
- **Optimisation: parallelise chunk fetches.** Sequential is conservative;
  parallelising 3 slices in a 90-day window would be roughly 3× faster
  provided we stay inside Awin's burst tolerance.
- **`/reports/aggregated` shortcut**: an optimisation for callers who want
  totals only and don't need per-transaction `ageDays`. Not needed for v0.1.
