# Example — "Audit my commissions across Awin and Impact"

The user has Awin and Impact configured as publisher networks. Today is
2026-07-20; the user accepted the defaults (90 days unpaid, 60 days stale
pending) and a 12-month window, 2025-07-20 to 2026-07-19.

**User**: Audit my commissions — what am I owed across my networks?

**Assistant**: Running the audit across Awin and Impact with the default
thresholds: approved-but-unpaid past 90 days since validation, reversals with
no stated reason, and pending transactions older than 60 days. These are my
thresholds, not the networks' contractual terms — tell me your actual terms
and I will re-run against them.

Called `affiliate_list_networks` → both `awin` and `impact` are registered
publisher-side adapters; `listTransactions` supported on both.

Pre-check, called `affiliate_awin_get_earnings_summary({ from: "2025-07-20", to: "2026-07-19" })` →
`oldestUnpaidAgeDays: 174`, `byStatus.approved: 41`, so the full pull is
warranted.

Called for Awin:

- `affiliate_awin_list_transactions({ status: "approved", minAgeDays: 90, from: "2025-07-20", to: "2026-07-19" })`
- `affiliate_awin_list_transactions({ status: "reversed", from: "2025-07-20", to: "2026-07-19" })`
- `affiliate_awin_list_transactions({ status: "pending", minAgeDays: 60, from: "2025-07-20", to: "2026-07-19" })`

The same three calls for Impact failed. Verbatim error from the envelope:

```
network: impact, operation: listTransactions, httpStatus: 401,
message: "Invalid credentials: account SID or auth token rejected"
```

## Commission audit — 2025-07-20 to 2026-07-19

Thresholds: unpaid = 90 days since validation (default, not a verified
contractual term); stale pending = 60 days.

**Coverage: 1 of 2 networks audited. Impact failed with the 401 above — its
figures are missing from every total below, not zero.**

### Found (Awin, GBP)

| Finding | Count | Commission | Oldest |
| --- | --- | --- | --- |
| Approved, not marked paid, 90+ days since validation | 9 | £1,412.40 | 174 days |
| Reversed with no stated reason | 4 | £286.10 | — |
| **Found total (approved-unpaid + unexplained reversals)** | **13** | **£1,698.50** | — |

Informational, not counted as owed:

| Finding | Count | Commission | Oldest |
| --- | --- | --- | --- |
| Pending older than 60 days | 6 | £342.75 | 133 days |

### Review list

One approved, apparently unpaid Awin transaction (`TXN-77120`, £58.20) has no
validation date, so its age can only be measured from conversion. It is
excluded from the found total until you can verify when it was validated.

### Next steps

- I can draft the Awin chase email with the 9 unpaid transactions attached —
  that runs through `chase-unpaid-commissions` and will match these totals.
- The 4 unexplained reversals are worth querying with Awin: the records show
  the commission was clawed back but carry no reason.
- Impact needs working credentials before it can be audited; run
  `affiliate-networks-mcp doctor impact` to diagnose, then I can re-run.
- If you want a shareable recap card of the audit, I can prepare one via the
  design kit; it will use these real figures anonymised, or carry a SAMPLE
  watermark.
