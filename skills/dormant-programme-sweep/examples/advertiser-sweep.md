# Worked example — production sweep on one Awin advertiser programme

A real run against a live Awin advertiser account, 11 August 2026. The brand,
account ID, and every publisher name are withheld: this is a third party's
commercial data, read through a legitimately configured advertiser token, and
only the aggregate shape is reproduced here. Every figure below came back from
the API on the day.

**User:** "How many publishers are actually selling anything for us?"

## What the skill did

Window: **12 August 2025 to 11 August 2026**.

Roster:

```
affiliate_awin-advertiser_list_media_partners({ })
```

524 publishers.

Producing set:

```
affiliate_awin-advertiser_list_transactions({ from: "2025-08-11", to: "2026-08-11" })
```

Awin caps the advertiser transaction window per call, so this ran as 12 chunked
requests and the rows were deduplicated by transaction `id` before counting:
3,628 unique transactions. Status split as returned: 2,749 approved, 594
declined, 283 pending, 2 deleted.

## Output

### Production ledger

| Programme | Roster | Producing | Non-producing | Non-producing % | Off-roster producers |
| --- | --- | --- | --- | --- | --- |
| (withheld) | 524 | 50 | 474 | 90.5% | 8 |

Window: 2025-08-11 to 2026-08-11.

**The roster is incomplete.** Eight publishers produced transactions in the
window while being absent from `list_media_partners`. The 524 is therefore a
lower bound on membership, and the 474 is "on the roster and not transacting",
not "confirmed inactive partners".

### Concentration

Total commission across the window: **33,367.33**. The API returned no currency
field on these rows, so the figure is reported in the programme's own reporting
currency without a symbol rather than guessing at one.

| Slice | Share of commission |
| --- | --- |
| Top 1 publisher | 39.8% |
| Top 3 | 70.2% |
| Top 5 | 78.5% |
| Top 10 | 89.9% |

50 publishers produced. Ten of them hold 89.9% of the commission, and a single
publisher holds 39.8%.

### Non-producing worklist

474 rows, withheld here. On a live run this is capped at 20 with the remainder
counted, and each row carries the publisher name and ID so the operator can
pick it up in `partner-outreach`.

## What this run does not prove

- **These are not confirmed dormant partners.** Awin's advertiser API exposes no
  relationship-status field, so a non-producing publisher here may be an active
  partner having a quiet year, a lapsed relationship, or a signup that never
  activated. For the relationship split, `partner-roster-audit` reads it from
  the operator's own Awin session instead.
- **The roster is a lower bound**, as the 8 off-roster producers demonstrate.
- **No benchmark.** 90.5% is this programme, this window. Nothing here says what
  is normal, and cross-tenant comparison is out of scope.
