# [discussion] Brand-side operations for v0.2 — request for comment

`affiliate-mcp` v0.1 covers the publisher side: read joined programmes, read
transactions, mint tracking links, check earnings. The natural next direction
is brand-side / advertiser-side operations — the view a brand running an
affiliate programme has into its own publishers.

This discussion is to scope what (if anything) v0.2 should include on that
axis, and to surface upstream API constraints before committing to anything.

## Candidate brand-side operations

- `list_publishers` — joined publishers for a brand programme.
- `get_publisher` — single publisher detail.
- `list_publisher_transactions` — transactions filtered by publisher.
- `approve_publisher` / `decline_publisher` — application moderation.
- `set_commission_rate` — per-publisher rate override.
- `list_brand_programmes` — programmes the brand operates.

## Open questions

1. Which of the bundled four networks (Awin, CJ, Impact, Rakuten) expose any
   of the above to brand-side API users?
2. Do any of them require a different credential or account type?
3. Is there demand from existing publisher users who also operate as brands?
4. Does covering brand-side conflict with the "local-only, bring-your-own-keys"
   posture, or fit naturally?

Reply on this issue with experience, links to API docs, or counter-proposals.
