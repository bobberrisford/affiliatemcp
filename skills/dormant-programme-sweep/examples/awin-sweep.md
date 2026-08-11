# Worked example — dormant sweep on one Awin publisher account

A real run against a live Awin publisher account, 11 August 2026. The account
name and publisher ID are withheld; every count and every programme name below
came back from the API on the day. Nothing here is illustrative.

**User:** "How many Awin programmes have I actually joined, and how many of them
have earned me anything this year?"

## What the skill did

Networks in scope: `awin` (publisher side). `awin-advertiser` credentials were
also configured and were skipped — the advertiser side is a brand's roster, not
a publisher's inventory.

Window agreed: **12 August 2025 to 11 August 2026** (the default 12 months).

Inventory pull:

```
affiliate_awin_list_programmes({ status: "joined" })
```

Earning set:

```
affiliate_awin_get_earnings_summary({ from: "2025-08-11", to: "2026-08-11" })
```

The summary returned `totalEarnings: 0` and an empty `byProgramme: []`. Because
Awin's adapter folds every transaction in the window into `byProgramme` rather
than returning a top-N ranking, an empty map is a genuine zero rather than a
truncated list. The underlying transactions endpoint was confirmed reachable
(HTTP 200, empty array) — this is an account with no transactions, not a failed
call. Had the call errored, the run would have stopped here rather than marking
2,415 programmes dormant on the strength of an outage.

## Output

### Inventory ledger

| Network | Joined | Earning | Transacting, not earning | Dormant | Dormant % |
| --- | --- | --- | --- | --- | --- |
| awin | 2,415 | 0 | 0 | 2,415 | 100% |

Window: 2025-08-11 to 2026-08-11. Programme status as returned: 2,408 `Active`,
7 `Hidden`.

### What the inventory is made of

The joined list spans 73 sectors and 6 primary currencies:

| Sector | Joined |
| --- | --- |
| Health & Beauty | 403 |
| Home & Garden | 342 |
| Clothing | 174 |
| Clothing Accessories | 128 |
| Computers | 121 |
| Sports Equipment | 105 |
| ...67 further sectors | 1,142 |

| Currency | Joined |
| --- | --- |
| USD | 1,339 |
| EUR | 587 |
| GBP | 398 |
| BRL | 22 |
| PLN | 20 |
| CAD | 13 |

Per-currency, as required — no FX applied. A GBP-reporting publisher holds 1,339
USD programmes here, which is worth knowing before anyone builds a single
"total".

### Reactivate — lapsed programmes

Not computed. The wider 24-month lookback was not run on this account, so the
dormant set is reported undivided: none of the 2,415 is confirmed as
*lapsed* rather than *never earned*.

### Drop candidates — never earned

Reported as a sample of a larger set: 2,415 rows is far past a readable table.
First 6 by programme ID:

| Programme | Joined | Sector |
| --- | --- | --- |
| Awin | not available | Business Services (B2B) |
| Cast In Style | not available | Home & Garden |
| Mobiles.co.uk | not available | Network Operators |
| CartridgeMonkey | not available | Office Supplies |
| GreatMagazines | not available | Books & Subscriptions |
| Memory Foam Warehouse | not available | Home & Garden |

2,409 rows not shown.

**Joined date is not available.** Awin's publisher programmes endpoint returns
`id`, `name`, `currencyCode`, `status`, `primaryRegion`, `primarySector`,
`description`, `displayUrl`, `clickThroughUrl`, `logoUrl`, and `validDomains` —
there is no join-date field. The column is left blank rather than filled with a
guess.

### The number

**2,415 joined. 0 earning.**

## Notes on this run

- 100% dormant is unusual and reflects what this account is: programmes
  accumulated without a publishing property actively driving traffic. The skill
  reports the count without editorialising, per its constraints.
- The lapsed/never-earned split is the most useful part of the sweep on an
  account with real revenue, and it is exactly the part that was skipped here.
  On a trafficking account, run step 5's wider lookback.
- Nothing was joined, left, or contacted. The sweep is read-only.
