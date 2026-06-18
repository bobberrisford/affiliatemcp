# Example — "Who's gone quiet on Acme?"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-06-18,
so the default activity window is 2026-03-20 to 2026-06-18 (90 days).

**User**: Who's gone quiet on Acme? I want to chase the partners that have stopped producing.

**Assistant**: Auditing Acme's roster and checking the last 90 days (2026-03-20 to 2026-06-18) for dormant partners...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_list_networks` → Awin advertiser exposes `list_media_partners`
and `get_programme_performance`, with no click-coverage limitation recorded, so
both clicks and conversions are genuine activity signals here.

Called:
- `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })` → 41 partners
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-03-20", to: "2026-06-18" })`

## Acme — roster audit (Awin)

Activity window 2026-03-20 to 2026-06-18 (90 days).

### Roster split

| Status | Count |
| --- | --- |
| Active | 33 |
| Pending | 4 |
| Inactive | 4 |

### Dormant worklist (active, no activity in window)

| Partner | Last observed activity |
| --- | --- |
| VoucherVault | no activity in window |
| TechReviewHub | no activity in window |
| GreenLivingBlog | no activity in window |

Three active partners produced nothing in the last 90 days. The remaining 30
active partners had at least one click or conversion.

### Pending and inactive

- 4 partners are awaiting a decision. For the full application queue use
  `partner-application-queue`.
- 4 partners are already marked inactive and are excluded from the dormant list.

---

The dormant list above is a worklist, not an action. To draft re-engagement
messages for VoucherVault, TechReviewHub, and GreenLivingBlog, use the
`partner-outreach` skill. Approving applications or marking a partner inactive
happens in the Awin dashboard.
