# Example — "Which partner applications are pending on Acme?"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-06-18.

**User**: Which partner applications are pending on Acme?

**Assistant**: Pulling Acme's application queue...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_list_networks` → Awin advertiser exposes `list_media_partners`
and reports a genuine `pending` status for applications awaiting a decision.

Called `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })` and
filtered to `status: "pending"` → 4 partners.

## Acme — application queue (Awin)

| Partner | Partner id | Status |
| --- | --- | --- |
| DealFinderUK | 557210 | pending |
| FitnessGearReviews | 557214 | pending |
| HomeOfficeHub | 557219 | pending |
| BudgetTravelNotes | 557223 | pending |

Four applications are awaiting a decision. Awin returns name, id, and status
only, so that is all that is shown.

---

This is a read-only queue. Approving or declining these applications happens in
the Awin dashboard.
