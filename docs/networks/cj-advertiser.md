# Setting up affiliate-mcp with CJ Affiliate (advertiser side) (estimated 8 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Acj%22)

This guide walks you through the credentials affiliate-mcp needs to read
your CJ Affiliate **brand / advertiser** account — the side of CJ that
runs programmes other publishers promote, not the publisher side that
earns commissions on a programme.

You will end up with one value written to `~/.affiliate-mcp/.env`:
`CJ_ADVERTISER_API_TOKEN`.

CJ uses a Personal Access Token (PAT) sent as
`Authorization: Bearer <PAT>` on every request. The adapter is
**read-only**: the GraphQL client refuses any operation that is not
`query` (no `mutation`, no `subscription`). This is defence-in-depth
against an accidentally introduced write — the brand surface is much
more sensitive than the publisher surface, and we want zero risk.

## The same PAT works for both publisher and advertiser sides

CJ scopes a PAT to whichever CIDs (Company IDs) the underlying user has
been granted. The same PAT addresses both the publisher commissions
endpoint and the advertiser commissions endpoint. If you have already
configured the publisher CJ adapter (`CJ_API_TOKEN`), the wizard will
surface that existing value when it prompts for
`CJ_ADVERTISER_API_TOKEN` and let you confirm or paste a different one.
We do **not** auto-copy: explicit confirmation keeps the wizard's
behaviour predictable, and you may prefer per-surface separation for
audit reasons.

## Prerequisites

- An approved CJ Affiliate **advertiser** account, or membership of one
  via your CJ Sign-In. Sign-in works at
  [https://members.cj.com/](https://members.cj.com/).
- API access on a CJ advertiser account does not require a separate
  approval step. As long as your account is active, you can generate a
  PAT at any time.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Steps

1. Sign in to CJ at
   [https://members.cj.com/](https://members.cj.com/).
2. Open the user-avatar menu in the top-right of the dashboard and
   click *Account*.
3. In the *Account* sidebar, open the *Personal Access Tokens* tab.
4. Click *Create Token*. Give it a name such as `affiliate-mcp-brand`.
   CJ shows the token value once and does not show it again — copy it
   immediately.
5. Run `npx affiliate-networks-mcp setup`, select **CJ Affiliate
   (advertiser)** when prompted, and paste the token. The wizard runs a
   cheap GraphQL probe (a 1-row `commissionDetails` query against a
   placeholder CID) to confirm the PAT is accepted by CJ.

## Brand discovery is manual

CJ does **not** publish a clean GraphQL query that enumerates the CIDs
a given PAT can address. The conventional GraphQL viewer / me /
currentUser query names are not verified against CJ's brand-side
schema; the `advertiserLookup` query requires you to already know the
CIDs. As a result, the adapter's `listBrands()` throws
`NotImplementedError` and the setup flow asks you to add brands by
hand.

To bind a CJ advertiser to a logical brand name in affiliate-mcp:

1. Find the CID in the CJ advertiser dashboard. It is shown at the top
   of the *Account* page and is also embedded in the URL of most
   dashboard pages.
2. Either run the setup wizard (recommended) or hand-edit the file:

   - **Wizard-driven (recommended).** Run `npx affiliate-networks-mcp
     setup` and choose **CJ Affiliate (advertiser)**. When the wizard
     reaches brand discovery the adapter throws
     `NotImplementedError` (CJ has no enumeration endpoint), the
     wizard prints *"this network's API doesn't expose brand
     discovery (this is normal for CJ). You'll need to add brands
     manually."*, and drops you into a small loop that prompts for a
     local brand slug + CID + optional display name. The wizard
     writes each entry to `brands.json` for you and loops until you
     decline to add another.

   - **Hand-edit.** Open `~/.affiliate-mcp/brands.json` and add an
     entry directly:

   ```json
   {
     "version": 1,
     "brands": {
       "acme": [
         {
           "network": "cj-advertiser",
           "credentialId": "default",
           "networkBrandId": "1234567"
         }
       ]
     }
   }
   ```

3. From then on, advertiser-side tools take `brand: "acme"` and the
   dispatcher resolves the right CID under the hood.

We would rather ship an honest gap than a fake endpoint. A future PR
will lift this if CJ exposes a clean enumeration query.

## Known limitations

- **Read-only at v0.1.** The GraphQL client refuses anything that is
  not `query`. To enable writes a future PR must lift the guard
  explicitly.
- **`listBrands` not implemented** — see "Brand discovery is manual"
  above.
- **`listProgrammes` is synthetic.** CJ has no advertiser-programmes
  endpoint; the adapter returns one Programme per CID resolved from
  the call context. Status defaults to `joined`; currency defaults to
  `USD`.
- **Clicks not available.** `commissionDetails` does not surface
  click-level data. `getProgrammePerformance` reports `clicks: 0`
  always. A future PR may augment this from a legacy REST report
  endpoint if a live tenant proves it reachable.
- **Status semantics are best-effort.** CJ's `actionStatus`
  (`EXTENDED` / `LOCKED` / `CLOSED` / `CORRECTED` / `REVERSED`) is
  mapped to the canonical 3-value performance state; CJ's CLOSED
  semantics in particular are `// TODO(verify)` against a live brand
  tenant.
- **USD-only currency.** All amounts use CJ's USD-normalised fields
  (`saleAmountUsd`, `commissionAmountUsd`); the brand's settlement
  currency is not surfaced on `commissionDetails`.
- **Pagination is cursor-based and capped.** `commissionDetails` caps
  page size at ~10k via `maxRows`; when no `limit` is supplied the
  adapter follows the `sinceCommissionId` cursor (guided by
  `payloadComplete`) until the window is complete, stopping at 10
  pages (100,000 rows) with a stderr warning rather than a silent
  truncation.

## Common failures

### `401 Unauthorized` when validating

Either the PAT was copied incorrectly or it has been revoked. Re-open
*Account → Personal Access Tokens* in the CJ dashboard and generate a
fresh token.

### `commissionDetails returned 200 with no records`

This typically means the PAT is valid but is not associated with the
CID you queried. Double-check the CID in `brands.json` matches the
advertiser account the PAT has been granted access to.

### Adapter refuses a write operation

This is by design. The CJ advertiser adapter is read-only at v0.1. If
you need to approve commissions or override a transaction state, do it
via the CJ dashboard for now.
