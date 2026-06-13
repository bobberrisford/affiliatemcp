# `docs/networks/`

Per-network setup walkthroughs — what a user needs to do in the
network's dashboard to get API credentials and wire them up. Each
page follows the same shape: prerequisites, step-by-step, common
failures, "what success looks like".

### Publisher side

- [Awin](./awin.md) — API token + publisher ID.
- [CJ Affiliate](./cj.md) — Developer Key (GraphQL).
- [eBay Partner Network](./ebay.md) — OAuth client + secret + campaign ID;
  approval required.
- [Impact](./impact.md) — Account SID + Auth Token.
- [Rakuten Advertising](./rakuten.md) — OAuth client + SID; approval required.

### Advertiser side

- [Awin (advertiser)](./awin-advertiser.md) — advertiser API token + account ID.
- [CJ Affiliate (advertiser)](./cj-advertiser.md) — Developer Key (GraphQL),
  advertiser-tier.
- [Impact (advertiser)](./impact-advertiser.md) — Account SID + Auth Token,
  advertiser scope.

Awin also has a [deeper API inventory](./awin/api-inventory.md) reflecting
its role as the reference implementation.

## Optional result cache

Caching is off by default and applies to every network once enabled. Set
`AFFILIATE_MCP_CACHE=on` in `~/.affiliate-mcp/.env` to store selected results
on disk so repeat questions within a freshness window skip the network
round-trip. What is cached and for how long:

- Programme inventory (`list_programmes`, `get_programme`): up to 24 hours.
- Closed reporting windows (`list_transactions`, `get_earnings_summary`,
  `list_clicks`): up to 30 days, but only when the request carries an explicit
  end date at least 48 hours in the past. Open or current windows always go
  live.
- Authentication checks and tracking-link generation are never cached.

Entries live under `~/.affiliate-mcp/cache/` (or
`$AFFILIATE_MCP_CONFIG_DIR/cache/` when that override is set) with mode `0700`
on the directory and `0600` on each entry file, the same owner-only posture as
the adjacent `.env`. Expired entries are deleted opportunistically on later
cache access. Remove everything cached at any time with
`affiliate-networks-mcp cache clear`, which reports the count and directory.

On a shared machine where you cannot rely on file permissions to keep other
users out of your home directory, leave caching off so transaction-level
results are never written to disk. See [`PRIVACY.md`](../../PRIVACY.md) for the
full storage and retention contract.
