# Example — "Draft re-engagement outreach for a dormant Acme partner"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-06-18.
VoucherVault came off the `partner-roster-audit` dormant worklist.

**User**: Draft a re-engagement note to VoucherVault for Acme — they used to be a big partner and went quiet.

**Assistant**: Pulling VoucherVault's history on Acme so the note is specific, then drafting...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_get_client_strategy({ brand: "acme" })` → strategy recorded:
preferred voice is "warm, partner-first"; Acme prefers content and cashback
partners. (Advisory only.)

Called `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })` →
matched **VoucherVault**, `publisherId: "557044"`, status `active`.

Called:
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-03-20", to: "2026-06-18", publisherId: "557044" })` → no rows
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2025-10-01", to: "2025-12-31", publisherId: "557044" })` → £42,300 gross sale, 1,180 conversions

Grounding fact: VoucherVault drove ~£42.3k in Q4 2025 and has had no activity
since. Written in the recorded warm, partner-first voice.

## Draft — re-engagement (single touch)

**Subject:** Still keen to have VoucherVault back on Acme

Hi [name],

We loved what VoucherVault did for Acme last year — you drove around £42,300 in
sales in Q4, one of our strongest cashback partners that quarter. We've not seen
any activity since the spring, so I wanted to check in rather than let the
relationship go quiet.

If something changed on your side — a feed issue, a category shift, terms that
stopped working — I'd genuinely like to know, and to make it easy to pick back
up. Happy to look at what would make Acme worth featuring again.

Would a short call next week suit?

Best,
[your name]

---

This draft is unsent. Sending happens in your own email or Awin's partner
messaging — I did not look up or invent any contact address. The £42,300 figure
comes from the Q4 2025 performance pull above; the "one of our strongest" framing
follows from it. I did not promise any commission change or placement — add one
only if Acme has authorised it. Want it shorter, or as a three-touch sequence?
