# Tool-result size budget: keep large account pulls under the client limit

- **Date:** 2026-07-03
- **Status:** Proposed (decision pending)
- **Affects:** the tool dispatch path in `src/server.ts`, the tool layer in
  `src/tools/generate.ts`, the brand-data export tools
  (`affiliate_get_brand_rows`), and the reporting skills that drive wide pulls.
  No adapter contract in `src/shared/types.ts` changes in the first phase.
- **Builds on:** `2026-06-12-adapter-result-caching.md` (the cache that makes
  response paging cheap), `2026-06-30-brand-data-layer.md` (the rows cap and
  local store this reuses), and `2026-06-29-desktop-data-export.md` (the
  existing precedent for writing exports to local files).

## Context

Claude clients cap the size of an MCP tool result. Claude Desktop and claude.ai
reject or truncate results at roughly 1 MB; Claude Code additionally applies a
token cap (25k tokens by default via `MAX_MCP_OUTPUT_TOKENS`). On larger
accounts a single wide pull, for example `affiliate_awin_list_transactions`
over a quarter, or `affiliate_get_brand_rows` with `format: "csv"`, produces a
result over that limit. The user sees a client-side failure after the server
has already done all the upstream work.

The server currently has no defence at any layer:

- `src/server.ts` serialises every result as one pretty-printed JSON text
  block, `JSON.stringify(result, null, 2)`. Pretty-printing inflates row data
  by roughly two to three times over compact JSON.
- Adapter list operations return bare arrays (`Transaction[]`, `Click[]`,
  `ProgrammePerformanceRow[]`). The query shapes accept `limit` and `cursor`,
  but the results carry no continuation token, so a client cannot ask for
  "the next page" even where an adapter honours `cursor`.
- Every `Transaction`, `Click`, and `Programme` row carries `rawNetworkData`,
  the verbatim upstream record. On many networks this is the majority of the
  bytes and is rarely needed for the workflows the skills drive.
- `affiliate_get_brand_rows` returns up to `ROWS_CAP` (~10k) rows, or the full
  CSV, inline in the tool result. At realistic row sizes both formats exceed
  1 MB well before the cap.

The repository already has the right honesty patterns to build on: adapters cap
pagination at `MAX_PAGES` with a logged warning rather than silent truncation,
and `src/brand-data/rows-cap.ts` collapses over-cap rows to aggregates with an
explicit `rowsTruncated` flag. What is missing is the same honesty at the
response boundary.

Principle 4.1 shapes the whole design: a result the client will reject must not
be sent, and whatever is sent instead must say exactly what happened and what
to do next. Silent truncation is not an option.

## Decision

### 1. A byte budget enforced at the single dispatch choke point

`src/server.ts` gains a response-size guard around the existing
`JSON.stringify` in the `CallToolRequestSchema` handler. The budget default is
**800,000 bytes** (UTF-8), leaving headroom under the 1 MB client limit for the
MCP envelope, and is overridable via `AFFILIATE_MCP_MAX_RESULT_BYTES` in
`.env.example`. One choke point, mirroring how the entitlement gate is applied,
so no per-tool opt-in can be forgotten.

### 2. Compact serialisation for large results

Results are serialised compactly (no indent) when the pretty-printed form would
exceed a readability threshold (64 KB). Small results stay pretty-printed for
human inspection; large results stop paying a two-to-three-times inflation for
whitespace nobody reads. This alone moves a band of currently failing pulls
back under the limit and changes no field of any result shape.

### 3. Honest overflow, not silent truncation

When even the compact form exceeds the budget, the guard returns a structured
`result_too_large` payload instead of the data:

```json
{
  "error": "result_too_large",
  "tool": "affiliate_awin_list_transactions",
  "resultBytes": 2417930,
  "budgetBytes": 800000,
  "itemCount": 8214,
  "hint": "Narrow the date window or status filter, pass a smaller limit, or use offset paging to retrieve the result in slices."
}
```

For results whose top level is an array, or a recognised list envelope, the
guard instead degrades honestly: it returns the largest prefix of items that
fits, wrapped as

```json
{
  "items": ["…"],
  "truncated": true,
  "returnedCount": 2100,
  "totalCount": 8214,
  "nextOffset": 2100,
  "hint": "Repeat the call with offset=2100 to continue."
}
```

Both shapes name the tool, the counts, and the remedy. Neither pretends the
pull succeeded whole. Un-truncated list results keep their current bare-array
shape byte-for-byte, so existing clients and skills see no change until a
result actually overflows, which today fails outright anyway.

### 4. Response paging at the tool layer, not the adapter layer

List tools gain an optional `offset` input (with the existing `limit` reused as
the page size). The slicing happens in `src/tools/generate.ts` after the
adapter returns, and the adapter-result cache from
`2026-06-12-adapter-result-caching.md` makes page two of the same query serve
from cache instead of re-pulling the network. This keeps all 86 adapters
untouched, keeps provider-neutral behaviour in the MCP layer, and gives every
network paging for free, including the ones whose upstream APIs have none.
Adapter-level cursor support remains an adapter-by-adapter concern and is out
of scope here.

### 5. File spill for exports

`affiliate_get_brand_rows` gains `format: "file"`. It writes the CSV (or JSONL
rows) to `$AFFILIATE_MCP_CONFIG_DIR/brand-data/<slug>/exports/` using the
store's existing atomic 0600 write pattern, and returns a small manifest: the
absolute path, format, row count, byte size, and the first few rows as a
preview. The operator, or a filesystem-capable client such as Claude Code,
takes it from there. This follows `2026-06-29-desktop-data-export.md`: the file
stays on the user's machine. The inline `rows` and `csv` formats remain, but
when their result would overflow the budget, the guard's `result_too_large`
hint names `format: "file"` as the remedy. File spill stays behind the same
entitlement gate as the rest of `affiliate_get_brand_rows`.

### 6. Skills steer before the guard has to act

The reporting and audit skills that drive wide pulls (`affiliate-earnings-report`,
`programme-performance-report`, and the link/commission audits) get a short
shared note: prefer `getEarningsSummary` for totals, pull transactions in
month-sized windows, and page with `offset` when a window is still too big. The
guard is the backstop; the skills should rarely trigger it.

## Rejected alternatives

- **Raising or ignoring the client limit.** It is the client's limit; the
  server must live within it.
- **Silent truncation at the budget.** Violates principle 4.1. A report built
  on silently missing rows is worse than a failed call.
- **Adding `nextCursor` to every adapter result shape.** The honest long-term
  pagination contract, but it changes `src/shared/types.ts` and all 86
  adapters at once for a problem the response layer can solve now. Revisit only
  if response paging proves insufficient, as its own decision.
- **Dropping `rawNetworkData` from list results by default.** The single
  biggest byte win, but it is a breaking change to a documented result shape
  that downstream clients may rely on. Deferred; if taken up later it should be
  an additive opt-out (`includeRaw`) governed by its own decision record.
- **Automatic aggregate fallback (rows-cap style) at the tool layer.** Right
  for the persisted brand store, wrong as a generic response transform: the
  caller asked for transactions and should not receive a different record shape
  because the account is large. Explicit paging keeps the shape stable.

## Consequences

- No currently succeeding call changes shape or content. Only calls that would
  today fail at the client boundary behave differently, and they now fail
  informatively or succeed in slices.
- The `truncated` list envelope and `result_too_large` payload become part of
  the public tool contract and are documented alongside `NetworkErrorEnvelope`.
- Byte-budget paging is approximate: the guard slices by serialized size, so
  page sizes vary with row weight. That is acceptable; the contract is "fits",
  not "fixed count".
- Claude Code's token cap is smaller than the byte budget in the worst case.
  The budget env var lets a Claude Code user lower the ceiling; automatic
  token-aware budgeting is out of scope.

## Implementation follow-ups (workstream brief)

User outcome: an operator on a large account can pull wide transaction windows
and export brand rows without hitting the client's 1 MB wall, and when a pull
is too big they are told exactly how to get the data anyway.

Dependency graph and lanes:

1. **PR 1 (this record), lane `active-risk`.** The decision. Nothing below
   starts as production work until it merges.
2. **PR 2: size guard plus compact serialisation, lane `active-risk`, depends
   on PR 1.** `src/server.ts` guard, `.env.example` entry, `result_too_large`
   and truncated-list shapes, unit tests over the dispatch path with synthetic
   oversized results. Acceptance proof: a synthetic 5 MB list result comes back
   as a within-budget truncated envelope; a 5 MB non-list result comes back as
   `result_too_large`; small results are byte-identical to today.
3. **PR 3: `offset` paging at the tool layer, lane `active-risk`, depends on
   PR 2.** Schema additions in `src/tools/generate.ts`, slice-after-cache
   wiring, tests proving page two of an identical query hits the cache.
4. **PR 4: `format: "file"` for `affiliate_get_brand_rows`, lane `routine`,
   depends on PR 1 only.** Store export writer, manifest shape, entitlement
   gate unchanged, tests beside `tests/tools/` and the brand-data store tests.
   Disjoint from PR 3's domain, so it may run in parallel with it.
5. **PR 5: skills guidance, lane `routine`, depends on PR 3.** Docs-only note
   in the wide-pull skills naming windows, summaries, and `offset`.

Risk gates: PRs 2 and 3 touch the shared dispatch path and the generated tool
contract, so they take the single risk lane in sequence, with an independent
agent review plus green CI as the backstop before Rob accepts each. PR 4 and
PR 5 are routine.

Stop conditions: if measurement during PR 2 shows compact serialisation alone
keeps realistic worst-case accounts (10k-row pulls) under budget, PR 3 may be
descoped to a follow-up issue rather than built speculatively. If Rob rejects
the truncated-list envelope as a contract addition, the guard falls back to
`result_too_large` only, and paging becomes the sole remedy.

Open questions for Rob before PR 2:

1. Is 800,000 bytes the right default budget, and is
   `AFFILIATE_MCP_MAX_RESULT_BYTES` the right override name?
2. Is the honest truncated-list envelope acceptable as an overflow-only
   contract addition, or should overflow always be a hard `result_too_large`?
3. Should a future `includeRaw` opt-out for `rawNetworkData` be queued as its
   own decision now, or wait for evidence that paging is not enough?
