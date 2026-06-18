# Example — "We just won Acme, health-check the account"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-06-18,
so the default data window is 2026-05-19 to 2026-06-18 (30 days).

**User**: We just won Acme. Health-check the account so I know what we can actually see.

**Assistant**: Running a one-off health check on Acme: connection, capabilities, and whether data is flowing...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_run_diagnostic({ network: "awin-advertiser" })` → auth ok;
`listProgrammes`, `getProgrammePerformance`, `listMediaPartners`, and
`listTransactions` are supported.

Called `affiliate_awin-advertiser_verify_auth` → ok.
Called `affiliate_list_networks` → Awin advertiser: claim status
`experimental`; supports `list_programmes`, `get_programme_performance`,
`list_media_partners`, `list_transactions`; `list_programmes` is synthetic and
`get_programme_performance` has tenant-specific column aliases still marked
`TODO(verify)`.

Exercised each supported operation once over 2026-05-19 to 2026-06-18:
- `affiliate_awin-advertiser_list_programmes({ brand: "acme" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-05-19", to: "2026-06-18" })`
- `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })`
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-05-19", to: "2026-06-18" })`

## Acme — programme health check (Awin)

**Connection**: auth ok. Claim status: experimental.

### Capability matrix

| Operation | Supported | Result |
| --- | --- | --- |
| list_programmes | yes | data (1 programme) |
| get_programme_performance | yes | data (28 publishers with rows) |
| list_media_partners | yes | data (41 partners) |
| list_transactions | yes | data (612 transactions) |

### Data presence

- Programmes: 1 synthetic programme row for the Acme advertiser account.
- Roster: 33 active, 4 pending, 4 inactive.
- Performance: rows for 28 publishers over the 30-day window.
- Transactions: 612 in the window (pending / approved / reversed mix present).

### Known limitations

- Awin advertiser is read-only at v0.1.
- Awin applies a 20-calls-per-minute user rate limit; the client queues calls.
- `list_programmes` is synthetic: one programme row for the advertiser account.
- `get_programme_performance` is available, but some report column aliases are
  still `TODO(verify)` against live tenants.

### Tracking-link check

Not verified by this skill. For live link verification, run the
`audit-affiliate-links` skill.

### Red flags and gaps

- None. Auth works, every core read operation returned data.

**Verdict**: the Acme connection is healthy end to end and ready to report on.
No gaps to resolve before the first weekly note.
