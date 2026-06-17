# Example — "build me an Awin link for Riverside Coffee"

An Awin publisher who wants a tracking link, with membership and quota checked
first.

**User**: build me an Awin link for Riverside Coffee to their cold-brew page.

**Assistant**: Checking Awin auth, then finding the advertiser and your quota
before generating.

Called `affiliate_awin_verify_auth` → OK.

Riverside Coffee is not a numeric advertiser ID, so finding it first:

- `affiliate_awin_list_programmes({ search: "Riverside Coffee", status: "joined" })`
  → advertiser `12345`, relationship `joined`.
- `affiliate_awin_get_link_builder_quota()` → 4,920 of 5,000 links remaining today.
- `affiliate_awin_get_programme_details({ advertiserId: 12345 })`
  → deeplinking supported, valid domains include `riversidecoffee.co.uk`.
- `affiliate_awin_generate_tracking_links({ advertiserId: 12345, destinationUrl: "https://riversidecoffee.co.uk/cold-brew" })`

## Result

| Field | Value |
| --- | --- |
| Advertiser | Riverside Coffee (`12345`) |
| Membership | Joined |
| Deeplink supported | Yes |
| Quota remaining today | 4,920 / 5,000 |
| Tracking URL | `https://www.awin1.com/cread.php?awinmid=12345&awinaffid=...&ued=https%3A%2F%2Friversidecoffee.co.uk%2Fcold-brew` |

### Notes

- Awin returned a long tracking URL only; no short URL was issued, so none is shown.
- The destination domain matched a valid domain on the programme, so the deeplink is safe to use.
- This is an Awin-only workflow. For a non-Awin advertiser, use that network's
  shared `generate_tracking_link` operation instead, which does not expose
  Awin's quota or programme-detail checks.
