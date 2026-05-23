/**
 * CJ advertiser GraphQL query strings.
 *
 * Extracted as module-level constants so the adapter code stays focused on
 * "what to do with the response", not "what the wire format looks like". Each
 * constant is a single GraphQL `query` operation — the read-only stance of
 * this adapter is enforced both at the client layer (which rejects anything
 * that isn't `query`) AND in policy here (no `mutation` strings live in this
 * file, ever).
 *
 * Field sets are deliberately minimal. CJ's schema drifts (fields rename,
 * leaves appear/disappear between tenants), so we read the fewest fields we
 * need. Anything more goes on `// TODO(verify):` lines until a live tenant
 * confirms it.
 */

/**
 * Auth probe: cheap, CID-agnostic. A valid PAT against a placeholder CID
 * returns an empty result set (200 OK, empty records). An invalid PAT returns
 * 401, which the client surfaces verbatim.
 *
 * We use `commissionDetails` rather than a `__schema` introspection because
 * introspection is sometimes disabled on production CJ endpoints, and we want
 * a probe that works regardless.
 */
export const VERIFY_AUTH_QUERY = /* GraphQL */ `
  query VerifyAuth($forAdvertisers: [String!]!, $maxRows: Int!) {
    commissionDetails(forAdvertisers: $forAdvertisers, maxRows: $maxRows) {
      payloadComplete
      count
    }
  }
`;

/**
 * The workhorse query: pull commission rows for a list of CIDs in a date
 * window.
 *
 * Argument shape (from CJ's published docs / third-party connector references):
 *   - forAdvertisers:     [String!]   — one or more CIDs
 *   - sincePostingDate:   DateTime    — ISO 8601 UTC
 *   - beforePostingDate:  DateTime    — ISO 8601 UTC
 *   - sinceCommissionId:  String      — pagination cursor
 *   - maxRows:            Int         — max ~10,000 per page
 *
 * Return shape (the leaves we actually read in `adapter.ts`):
 *   payloadComplete, count, records[]
 *
 * Per-record fields used downstream:
 *   commissionId, advertiserId, publisherId, publisherName,
 *   postingDate, eventDate, actionStatus, actionType,
 *   saleAmountUsd, commissionAmountUsd, items[]
 *
 * Everything else lives on `rawNetworkData` so downstream consumers can drill
 * in without us widening the canonical type.
 */
export const COMMISSION_DETAILS_QUERY = /* GraphQL */ `
  query CommissionDetails(
    $forAdvertisers: [String!]!
    $sincePostingDate: DateTime
    $beforePostingDate: DateTime
    $sinceCommissionId: String
    $maxRows: Int
  ) {
    commissionDetails(
      forAdvertisers: $forAdvertisers
      sincePostingDate: $sincePostingDate
      beforePostingDate: $beforePostingDate
      sinceCommissionId: $sinceCommissionId
      maxRows: $maxRows
    ) {
      payloadComplete
      count
      records {
        commissionId
        advertiserId
        advertiserName
        publisherId
        publisherName
        postingDate
        eventDate
        actionStatus
        actionType
        saleAmountUsd
        commissionAmountUsd
        items {
          quantity
          totalCommissionUsd
          perItemSaleAmountUsd
        }
      }
    }
  }
`;

/**
 * Advertiser lookup: the "what is the human-readable name for this CID?"
 * query. Used by `listProgrammes` to surface a Programme per CID, and by
 * `listBrands` when the user supplies an explicit CID list (the adapter
 * does not generally enumerate CIDs — CJ has no clean endpoint for that;
 * see `adapter.ts.listBrands` for the rationale).
 *
 * TODO(verify): `requestorCid` is required by some tenants; on others
 * `advertiserLookup` accepts just `advertiserIds`. The adapter passes the
 * first CID in the list as requestorCid for compatibility — adjust against
 * a live tenant.
 */
export const ADVERTISER_LOOKUP_QUERY = /* GraphQL */ `
  query AdvertiserLookup($advertiserIds: [String!]!, $requestorCid: String!) {
    advertiserLookup(advertiserIds: $advertiserIds, requestorCid: $requestorCid) {
      resultList {
        advertiserId
        advertiserName
        accountStatus
        programTerms {
          currency
        }
      }
    }
  }
`;
