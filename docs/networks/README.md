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
