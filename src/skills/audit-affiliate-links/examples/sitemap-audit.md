# Example — auditing a small sitemap

A publisher with two networks configured (Awin + Rakuten) wants a quick sweep of their three most recent blog posts.

**User**: Can you audit the affiliate links on these three posts? Here are the URLs: ...

**Assistant** (after fetching each post): I found 14 outbound links. Six are affiliate links — four on Awin (`awin1.com`), two on Rakuten (`click.linksynergy.com`). The other eight are editorial links to manufacturer sites with no tracking.

Calling `affiliate_list_networks` to confirm wiring... both `awin` and `rakuten` are registered.

For each affiliate link I parsed the merchant id from the query string and called the matching `affiliate_<slug>_get_programme`:

| Link | Network | Programme | Status | Recommendation |
| --- | --- | --- | --- | --- |
| awin1.com/cread.php?...&m=12345 | Awin | Acme Outdoor | joined | OK |
| awin1.com/cread.php?...&m=67890 | Awin | Quill Stationery | declined | Replace — programme no longer accepts publishers. |
| awin1.com/cread.php?...&m=24680 | Awin | Riverside Coffee | joined | OK |
| awin1.com/cread.php?...&m=13579 | Awin | (404 from get_programme) | unknown | Verify in the Awin dashboard; surface verbatim error below. |
| click.linksynergy.com/...&id=99001 | Rakuten | Northshore Gear | joined | OK |
| click.linksynergy.com/...&id=99099 | Rakuten | Old Bay Books | suspended | Replace — programme suspended on 2026-04-12. |

Verbatim error for Acme: `{ httpStatus: 404, networkErrorBody: '{"error":"programme not found"}' }`.

Would you like me to regenerate the Quill Stationery and Old Bay Books links against active alternatives? I'd need a destination URL for each.
