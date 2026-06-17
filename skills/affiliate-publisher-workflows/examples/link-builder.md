# Example — "build me a link for Riverside Coffee"

Two networks, showing how the same workflow uses richer tools on Awin and the
shared surface elsewhere.

## On Awin (rich tools present)

**User**: build me an Awin link for Riverside Coffee to their cold-brew page.

**Assistant**: Checking Awin auth, then membership and quota before generating.

Called `affiliate_awin_verify_auth` → OK.

- `affiliate_awin_list_programmes({ search: "Riverside Coffee", status: "joined" })`
  → advertiser `12345`, joined.
- `affiliate_awin_get_link_builder_quota()` → 4,920 / 5,000 remaining today.
- `affiliate_awin_get_programme_details({ advertiserId: 12345 })`
  → deeplinking supported, valid domain `riversidecoffee.co.uk`.
- `affiliate_awin_generate_tracking_links({ advertiserId: 12345, destinationUrl: "https://riversidecoffee.co.uk/cold-brew" })`

| Field | Value |
| --- | --- |
| Programme | Riverside Coffee (`12345`) |
| Membership | Joined |
| Deeplink supported | Yes |
| Quota remaining today | 4,920 / 5,000 |
| Tracking URL | `https://www.awin1.com/cread.php?awinmid=12345&awinaffid=...&ued=...cold-brew` |

Quota and deeplink checks ran because Awin exposes those tools.

## On a network without the rich tools

**User**: now do the same on CJ.

**Assistant**: CJ's tool list has the shared link operation but no quota or
programme-details tools, so I will use the shared surface and say what is not
checked.

Called `affiliate_cj_verify_auth` → OK.

- `affiliate_cj_list_programmes({ search: "Riverside Coffee", status: "joined" })`
  → programme `987`, joined.
- `affiliate_cj_generate_tracking_link({ programmeId: "987", destinationUrl: "https://riversidecoffee.co.uk/cold-brew" })`

| Field | Value |
| --- | --- |
| Programme | Riverside Coffee (`987`) |
| Membership | Joined |
| Deeplink supported | Not reported by CJ |
| Quota | Not available on CJ |
| Tracking URL | `https://www.anrdoezrs.net/click-...-cold-brew` |

### Notes

- The core workflow is identical across networks; the quota and deeplink-support
  checks only appear where the network implements those operations.
- No figures or statuses were invented for CJ; the missing checks are stated, not
  filled in.
