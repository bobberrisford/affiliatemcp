---
name: dormant-programme-sweep
description: |
  Use this skill to measure the gap between partnerships on the books and partnerships producing anything, on either side of the market. For a publisher: how many programmes they have joined, how many actually earned in a period, and which are dead weight. For an advertiser or agency: how many publishers are on the programme's roster, how many produced a transaction, and how concentrated the revenue is among the few that did. The output is a read-only worklist; it never applies to, leaves, approves, or contacts anyone.
  Trigger on: "how many programmes have I joined?", "which of my affiliate programmes are dead?", "how many of our publishers actually sell anything?", "which publishers have never produced a sale?", "audit my joined programmes", "dormant programme sweep", "how concentrated is our partner revenue?".
---

# Operating instructions

You are auditing a publisher's **own joined-programme inventory**: the
programmes they have joined on each network, set against the programmes that
actually produced commission in a chosen window. The outcome is a worklist of
what to reactivate and what to drop, not a performance ranking.

Joined-programme inventory grows monotonically. Publishers join programmes for a
campaign, a seasonal push, or a client that has since left, and nothing ever
prunes the list. The cost is not money, it is attention: every stale programme
is a row in a feed, a merchant in a newsletter template, a link that may still
be live on a page nobody has audited.

This is distinct from:

- `affiliate-earnings-report` — what you earned, ranked. This skill is about
  what you joined and did **not** earn from.
- `partner-roster-audit` — the advertiser-side equivalent (a brand auditing its
  publisher roster). This skill is publisher-side.
- `audit-affiliate-links` — link health on pages. This skill is programme
  membership, regardless of whether any link exists.

This skill is read-only. It never joins, leaves, applies to, or contacts a
programme. To act on the reactivation list, use `partner-outreach`; to apply to
new programmes on Awin, use `awin-apply-to-programmes`.

## Step 1 — identify the configured networks

Use publisher networks the user named or confirmed they configured. If none are
known, ask which networks to include. Call `affiliate_list_networks` only to
confirm that this server has a registered adapter for each named network; it
does not prove that credentials are configured. When credential state is
uncertain, recommend `affiliate-networks-mcp doctor <slug>` or attempt the
requested operation and surface its verbatim error.

Only publisher-side networks (`side === 'publisher'`) are in scope — the joined
inventory is a publisher's own membership list. Skip any `side === 'advertiser'`
entries and say so.

Inspect each network's `knownLimitations`. Where `listProgrammes` is
unsupported, the inventory cannot be built for that network: report the coverage
gap rather than treating it as an empty inventory.

## Step 2 — agree the window

Default window: the **last 12 months**, ending today. If the user named a
different period, honour it. Express dates as ISO `YYYY-MM-DD` and state the
window in the output.

The window is the definition of "dormant". A programme that last earned 13
months ago is dormant against a 12-month window and active against a 24-month
one. Never present "dormant" as an absolute property of a programme; it is
always relative to the window you used, and you must say which.

## Step 3 — pull the joined inventory

For each network slug `s`:

```
affiliate_<s>_list_programmes({ status: "joined" })
```

Retain, per programme: `id`, `name`, `currency`, and `status`. Count the
inventory. On large accounts this list runs to thousands of rows — see **Large
accounts** below before pulling it raw.

If the network returns programmes the publisher has *not* joined (some adapters
return the whole catalogue when `status` is unsupported as a filter), keep only
rows whose `status` is `joined` and say that you filtered client-side. Do not
count a catalogue as an inventory: it would inflate every number in the report.

## Step 4 — pull the earning set

For the same window, for each network:

```
affiliate_<s>_get_earnings_summary({ from: <iso>, to: <iso> })
```

Read `byProgramme[]`. Each entry carries `programmeId`, `programmeName`,
`total`, `currency`, and `transactionCount`. This is the **earning set**.

Treat `byProgramme` as authoritative for "which programmes earned" only when the
adapter derives it from a complete transaction pull over the window. Awin does:
its adapter folds every transaction in the window into the map, so a joined
programme absent from `byProgramme` genuinely produced no commission. Where an
adapter documents `byProgramme` as a top-N ranking, absence is **not** proof of
zero: say so, and either verify the specific programmes with
`affiliate_<s>_list_transactions({ programmeId })` or label that network's
dormant list "unverified".

If the summary call fails, surface the verbatim error (network, operation,
message, httpStatus) and do not continue to step 5 for that network. A failed
earnings call must never be read as "nothing earned" — that would mark the
entire inventory dormant on the strength of an outage.

## Step 5 — classify the inventory

Per network, set the joined inventory against the earning set by `programmeId`
and place every joined programme in exactly one bucket:

- **Earning** — present in `byProgramme` with `total > 0`.
- **Transacting, not earning** — present in `byProgramme` with `total <= 0`.
  Usually reversals outweighing sales. Worth a look; not dormant.
- **Dormant** — joined, absent from `byProgramme` for the window.

Then split **Dormant** by whether it ever earned. For a bounded number of
dormant programmes (default: the 20 the user most cares about, or all of them if
the inventory is small), re-run the summary over a wider lookback (default: the
preceding 24 months) and split:

- **Lapsed** — earned before the window, nothing in it. These are the
  reactivation candidates: the relationship worked once.
- **Never earned** — no commission in the window or the lookback. These are the
  drop candidates.

If you do not run the wider lookback, do not guess. Report the dormant set
undivided and say the lapsed/never-earned split was not computed.

## Step 6 — present the sweep

Lead with the inventory ledger, per network:

| Network | Joined | Earning | Transacting, not earning | Dormant | Dormant % |
| --- | --- | --- | --- | --- | --- |

Then the two worklists, each capped at a readable length (default 20 rows, and
say how many were not shown):

**Reactivate — lapsed programmes**

| Programme | Last earned | Total in lookback | Currency |
| --- | --- | --- | --- |

**Drop candidates — never earned**

| Programme | Joined | Sector / region if available |
| --- | --- | --- |

Close with the one number that matters: joined versus earning. State it flatly,
without commentary about what it says about the publisher.

Sum every total **per currency**; never apply FX. A multi-currency inventory
gets one row per currency, not a converted total.

## Large accounts

A mature publisher account can hold thousands of joined programmes. Keep every
tool result inside the client's size limit:

- Pull the inventory with `limit` and page through with `cursor` rather than
  requesting the whole list at once.
- Prefer `get_earnings_summary` over `list_transactions` for the earning set:
  the summary answers "which programmes earned" without returning a row per
  sale.
- If a result returns `truncated: true` or `result_too_large`, follow its hint:
  continue from the given `nextOffset`, or narrow the window. Never classify a
  truncated inventory as if it were complete — a partial inventory pull makes
  the dormant count meaningless.
- When the inventory is too large to enumerate, report the counts and the top
  worklist rows, and say explicitly that the per-programme tables are a sample
  of a larger set.

## Constraints

- Read-only. Joining, leaving, and contacting a programme are the user's
  actions, not this skill's.
- "Dormant" is always relative to the stated window. Never present it as an
  absolute judgement on a merchant.
- Never infer that a programme is dead because the earnings call failed. Surface
  the verbatim error and exclude that network from the ledger.
- Never invent a "last earned" date. If the lookback was not run, leave the
  column blank and say the split was not computed.
- Sum per currency. Never normalise or convert.
- A large dormant count is not evidence of a badly run account: joined
  inventory accumulates by design on most networks, and some programmes are
  joined for coverage rather than revenue. Report the number; do not editorialise
  about it.
- Do not recommend dropping a programme whose commission is zero only because
  the window is short. Say what the window was and let the user decide.

# Advertiser side — the production sweep

The same shape runs for a brand or agency, with the sides swapped: the roster of
publishers on the programme, set against the publishers that actually produced a
transaction in the window. Recruitment is the advertiser-side equivalent of
joining — it only ever adds — so the same gap opens up and nothing closes it.

## What this does and does not measure

This is deliberately a **production** sweep, not a relationship sweep, and the
difference matters.

`partner-roster-audit` answers "which partners have an *active relationship* and
have gone quiet". That needs a relationship-status field. Awin's advertiser API
does not expose one, which is why that skill reads Awin's status from the
operator's own browser session and says dormancy cannot be derived from the API.
That remains true and this skill does not change it.

This skill answers the weaker, API-derivable question: **"which publishers on
the roster produced nothing in the window?"** It needs no status field, only the
roster and the transactions. A publisher counted here as non-producing may be an
active partner who simply had a quiet year, a lapsed relationship, or a
never-activated signup. This skill cannot tell those apart. Say so in the
output, and point at `partner-roster-audit` when the user needs the
relationship split.

## Step A — pull the roster

```
affiliate_<network>-advertiser_list_media_partners({ })
```

Retain `id` and `name` per publisher. Count it.

**The roster may be incomplete.** Verified against a live Awin advertiser
programme on 2026-08-11: 8 publishers produced transactions in the window while
being absent from the roster response. Treat the roster as a lower bound on
membership, not a census. Always reconcile (step C) rather than assuming every
transacting publisher appears in it.

## Step B — pull the producing set

```
affiliate_<network>-advertiser_list_transactions({ from: <iso>, to: <iso> })
```

Group by `publisherId`. For each, count transactions and sum commission **per
currency**. This is the **producing set**.

Awin's advertiser transaction endpoint caps the window per call; the adapter
chunks it. Do not hand-roll a single 12-month call and read a truncated response
as the full year. Deduplicate by transaction `id` across chunk boundaries before
counting anything — overlapping windows will otherwise double-count.

## Step C — reconcile and classify

Three groups, and all three get reported:

- **Producing** — on the roster, ≥1 transaction in the window.
- **Non-producing** — on the roster, no transaction in the window.
- **Producing but off-roster** — transactions in the window, absent from the
  roster response. This group is the evidence that the roster is incomplete. If
  it is non-empty, say so explicitly and do not present the roster count as a
  complete membership figure.

## Step D — concentration

The count alone understates the problem, so compute what share of commission the
top 1, 3, 5, and 10 publishers hold. On a real programme this is routinely far
more skewed than operators expect, and it is the number that changes a decision:
a roster of hundreds where one publisher carries most of the revenue is a
concentration risk, not a healthy partner base.

Report it per currency, and never apply FX.

## Step E — present the brand-side sweep

| Programme | Roster | Producing | Non-producing | Non-producing % | Off-roster producers |
| --- | --- | --- | --- | --- | --- |

Then the concentration table, then the non-producing worklist capped at a
readable length. Close with the count and the concentration together — either
alone tells half the story.

## Advertiser-side constraints

- Read-only. Approving, declining, pausing, and contacting a publisher are the
  operator's actions. Use `partner-outreach` to draft re-engagement.
- Never call a publisher dormant on this evidence alone. The honest label is
  "no transactions in <window>", and the output must use that wording.
- A programme's roster is a lower bound. Report the off-roster producers count
  every time, including when it is zero.
- Deduplicate by transaction id before counting. Chunked windows overlap.
- This sweep reads one operator's own programme data. It is not a benchmark and
  must not be compared against other brands: cross-tenant aggregate comparison
  is gated on its own decision record and is not in scope here.
