---
name: affiliate-network-status
description: |
  Use this skill when the user wants a health check of their configured affiliate networks — auth, reachability, supported operations.
  Trigger on: "is my affiliate setup working", "check my affiliate networks", "are all my networks responding", "network health".
---

# Operating instructions

You are reporting on the health of all configured affiliate networks. The single source of truth is `affiliate_run_diagnostic`.

## Step 1 — run the diagnostic

Call `affiliate_run_diagnostic` with no arguments. It returns one `NetworkCapabilities` record per registered network:

```
{
  network: "<slug>",
  generatedAt: "<iso>",
  operations: {
    listProgrammes:      { supported: true,  latencyMs: 412, sampleSize: 25 },
    getProgramme:        { supported: true,  latencyMs: 198 },
    listTransactions:    { supported: true,  latencyMs: 980, sampleSize: 12 },
    getEarningsSummary:  { supported: true,  latencyMs: 1020 },
    listClicks:          { supported: false, note: "not exposed by this network's public API" },
    generateTrackingLink:{ supported: true,  latencyMs: 230 },
    verifyAuth:          { supported: true,  latencyMs: 140, note: "identity=pub-12345" }
  },
  knownLimitations: [...]
}
```

If `affiliate_run_diagnostic` itself returns an empty array, no networks are wired up — tell the user to run `affiliate-mcp setup`.

## Step 2 — interpret per-network

For each network in the response, decide a status:

- **OK** — every operation that the network ought to support reports `supported: true` and `latencyMs` is reasonable (< 5000ms).
- **DEGRADED** — `verifyAuth` is OK but one or more publisher operations failed *unexpectedly* (i.e. they're not in `knownLimitations`).
- **FAILING** — `verifyAuth.supported === false`. Auth is broken; the rest is noise until that's fixed.

An operation reported as unsupported when it appears in `knownLimitations` is not a failure — it's expected. Don't alarm the user about Awin's missing click data.

## Step 3 — present results

Two-part output:

### Summary table

| Network | Status | Auth | Ops failing unexpectedly | p95 latency |
| --- | --- | --- | --- | --- |

### Recommendations

Bullet list, one per affected network. Be specific:

- Auth failing: "Awin auth check failed: `<verbatim message>`. Run `affiliate-mcp doctor awin` for the full diagnostic JSON. Likely cause: rotated or revoked API token (regenerate at https://ui.awin.com under your publisher profile)."
- Operation failing unexpectedly: "CJ listTransactions returned an error: `<verbatim>`. Run `affiliate-mcp doctor cj` to capture the full response body."
- Latency unusually high: "Impact listTransactions p95 is 8.4s — upstream is flaky today. The adapter retries automatically; expect intermittent slowness."

If everything is green: a single line — "All N networks healthy as of `<iso>`."

## Constraints

- Never invent operation results. The diagnostic is the source of truth.
- Surface verbatim error bodies from the envelope when an operation fails — do not paraphrase.
- Recommend `affiliate-mcp doctor <slug>` (not raw curl commands) when the user wants the full JSON.
- Pair this skill with per-network `affiliate_<slug>_verify_auth` if the user wants to re-check a single network after rotating credentials.
