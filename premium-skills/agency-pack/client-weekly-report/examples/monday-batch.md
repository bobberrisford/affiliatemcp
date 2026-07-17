# Example — "Run the Monday reports for every client"

The agency has three registered brands: Acme (Impact), Riverside (Awin), and
Quill (Impact and Awin). Acme has a recorded strategy naming a formal voice
and a 20% drop escalation threshold; Riverside and Quill have no recorded
strategy. Today is Monday 2026-07-13.

**User**: Run the Monday reports for every client.

**Assistant**: Found three registered brands. Loading recorded voices and
pulling last week (2026-07-06 to 2026-07-12) vs. the prior week
(2026-06-29 to 2026-07-05) for each...

Called `affiliate_resolve_brand` → Acme, Riverside, Quill bindings.
Called `affiliate_list_client_strategies` → Acme has a recorded strategy and
KPI; Riverside and Quill have none.
Called `affiliate_get_client_strategy({ brand: "acme" })` → formal voice,
"flag any drop over 20% immediately".
Called `affiliate_build_brand_snapshot({ brand: "acme" })`,
`affiliate_build_brand_snapshot({ brand: "riverside" })`,
`affiliate_build_brand_snapshot({ brand: "quill" })`.

## Batch ledger

- 3 brands processed.
- 1 brand (Acme) using its recorded voice and escalation threshold.
- 2 brands (Riverside, Quill) using the default weekly-note format.
- 1 brand (Acme) crossed its escalation threshold this week.
- 0 failures.

## Draft — Acme

**Subject:** Weekly update — Acme — week of 2026-07-06

> **Immediate flag: gross sale is down 23% this week, over the 20% threshold
> you asked us to raise straight away.**
>
> Acme's week: £41,200 gross sale, down from £53,600 the week before (-23.1%).
>
> | Network | Gross sale | Commission | Conversions |
> | --- | --- | --- | --- |
> | Impact | £41,200 | £4,120 | 1,180 |
>
> Top fallers: CashbackCo (-£8,900), VoucherHub (-£3,100), TechReviews (-£1,400).
> Top risers: none this week.
>
> Watch items: the drop is broad-based across the top three partners, not one
> outlier — worth a quick call to confirm nothing changed on tracking.

## Draft — Riverside

**Subject:** Weekly update — Riverside — week of 2026-07-06

> Riverside's week: £18,400 gross sale, up from £17,900 the week before
> (+2.8%).
>
> | Network | Gross sale | Commission | Conversions |
> | --- | --- | --- | --- |
> | Awin | £18,400 | £1,840 | 512 |
>
> Top risers: DealFinder (+£620). Top fallers: none material.
>
> No recorded voice for Riverside; using the default weekly-note format.

## Draft — Quill

**Subject:** Weekly update — Quill — week of 2026-07-06

> Quill's week: £9,100 gross sale (Impact) + £4,300 (Awin) = £13,400 combined,
> roughly flat versus £13,650 the week before (-1.8%).
>
> | Network | Gross sale | Commission | Conversions |
> | --- | --- | --- | --- |
> | Impact | £9,100 | £910 | 240 |
> | Awin | £4,300 | £430 | 118 |
>
> No material risers or fallers this week.
>
> No recorded voice for Quill; using the default weekly-note format.

---

Each draft is send-ready with a `[client contact]` placeholder for the
recipient. Review and send yourself. For the whole-book headline instead of
per-client notes, use the free `agency-portfolio-rollup` skill.
