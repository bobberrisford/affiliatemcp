# Network claim process

> Stub. This document will be expanded once the first adapter is promoted
> from `claim_status: partial` to `production`. Until then, every bundled
> adapter is `partial`.

A "claim" is the project's statement that a given network adapter is fit
for production use by a real publisher account. The status lives in each
network's `network.json` under the `claim_status` key. Permitted values:

- `partial` — implemented and tested against fixtures; not yet exercised
  end-to-end against a live publisher account. All four bundled adapters
  currently sit here.
- `production` — exercised against a live account, all supported
  operations confirmed against real data, no unresolved issues in
  [`docs/findings/<slug>.md`](./findings/).
- `degraded` — was `production`; a regression has been observed but the
  adapter still works for most operations. The findings doc will list the
  affected operations.
- `broken` — the network's API has changed or gone away. No tools are
  exposed. A `broken` adapter blocks `npm run build` from completing if
  the network is still referenced in `src/shared/registry.ts`.

## Tracking granularity

Claims are tracked at two levels:

- **Adapter claim status** in `src/networks/<slug>/network.json`, used for the
  public table and release posture.
- **Endpoint and journey status** in `docs/networks/<slug>/api-inventory.md`,
  used to show exactly which public API surfaces are implemented,
  fixture-tested, live-tested, gated, or intentionally unsupported.

For Awin, the endpoint inventory is mandatory PR context. A future network
should follow the same pattern once it becomes the reference-quality focus.

## Promotion criteria (draft)

To move an adapter from `partial` to `production`:

1. The full set of canonical operations declared `supported` in
   `network.json` returns valid envelopes against a real publisher
   account, with at least one non-trivial result per operation.
2. Every endpoint marked `Supported` in that network's API inventory has
   fixture coverage and a live-test status of either validated or explicitly
   empty-but-200 for the tested account.
3. Every user journey listed in the inventory has a fixture-backed test and a
   documented live-test outcome where live data is available.
4. Gated or write-capable endpoints have clear activation requirements and do
   not run live writes unless the maintainer explicitly approved that test.
5. `npx affiliate-networks-mcp doctor <slug>` is green on a clean install.
6. The findings doc records the test date and the (redacted) shape of the
   response for each operation.
7. A maintainer signs off on the promotion PR.

## Demotion criteria

Any contributor can file an issue with the [`correction.yml`](../.github/ISSUE_TEMPLATE/correction.yml)
template requesting a demotion. The trigger should be one of:

- A live operation that previously worked now returns errors against a
  configured account.
- A field documented as populated is observed empty across multiple
  fixtures.
- The network has changed authentication, endpoint URLs, or response
  shape in a way that the current adapter does not handle.

The default response to such an issue is to demote first (to `degraded`
or `broken`) and investigate from there. Better to over-report than to
let a stale claim stand.

## Why this matters

Publishers make business decisions based on the data this server
surfaces. If `REPORT.md` says an operation works and it does not, that is
a more serious bug than a stack trace. The claim status is how we keep
that promise honest.
