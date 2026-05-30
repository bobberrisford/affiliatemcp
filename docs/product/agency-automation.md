# Recording client strategy

This document describes how `affiliate-mcp` should **record an affiliate agency's
per-client strategy** so that the reporting and anomaly work it already does can be
judged against what each client is actually trying to achieve.

It is a design note, not a built feature. It sits alongside
[`manifesto.md`](./manifesto.md) and
[`ai-native-affiliate-data.md`](./ai-native-affiliate-data.md), and it defines the
**next build** for the agency/brand side of the project.

## Why this exists

Most of an affiliate agency's regular work is **reporting and anomaly suggestion**, and
that is already this project's strength. The skills today produce earnings reports,
portfolio rollups, single-brand performance reports, and week-over-week anomaly scans
(see [`programme-anomaly-watch`](../../skills/programme-anomaly-watch),
[`agency-portfolio-rollup`](../../skills/agency-portfolio-rollup),
[`programme-performance-report`](../../skills/programme-performance-report)). The brand
layer in [`src/shared/brands.ts`](../../src/shared/brands.ts) already binds a logical
client slug to the network brand IDs behind it.

What is missing is not an action engine — it is **per-client context**. Today a report
can say "Acme revenue is down 18% week-over-week," but it has no view on whether 18%
matters to Acme, whether Acme is still ahead of its quarterly target, or whether the
drop sits in a channel Acme has explicitly deprioritised. The numbers are generic
because the client's intent lives in a kickoff deck, an email thread, or someone's head
— never anywhere Claude can read.

So the unit of work here is to **record the strategy**: capture what each client is
trying to do, in a form Claude reads before it reports.

## Scope and non-goals

In scope:

- A simple, local, human-readable way to record each client's affiliate strategy and
  KPIs.
- Capturing and editing that record by chatting with Claude.

Explicit non-goals:

- **No execution layer.** This does not approve or decline publishers, change commission
  rates, launch offers, or otherwise write to any network. The product remains reporting
  and anomaly *suggestion*; a human carries out actions. This upholds the manifesto's
  "public APIs only" and "no fake support" principles.
- **No delivery autonomy / permission model yet.** How reports get scheduled or sent, and
  any "run without asking" convenience, are deferred (see Roadmap).
- **No new structured schema.** The record is prose markdown the operator can read and
  edit, not a JSON contract.

## The agency's regular work

Recording strategy is worth doing because nearly every recurring agency task is a
reporting or anomaly task that becomes sharper with client context:

- **Daily** — performance pulse; anomaly watch for revenue drops, reversal spikes,
  publisher dropouts, and tracking breakage.
- **Weekly** — performance brief, top movers, pending and at-risk commission review.
- **Monthly** — client report, commission validation, payout and invoice reconciliation.
- **Quarterly** — QBR prep, strategy-versus-goals review.
- **Event-driven (suggestion only)** — partner recruitment ideas, offer and commission
  *recommendations*, link and compliance audit flags, coupon-leakage alerts.

Every one of these is something the existing skills do or could do; none of them require
writing to a network.

## Per-client strategy as living markdown

Each client gets a small set of **living markdown files** that Claude reads as context —
in the spirit of the `soul.md` pattern: prose the operator maintains, not a schema to
fill. Two files per client:

### `Strategy.md`

The client's affiliate priorities in plain prose. Typical sections:

- **Objectives** — what this client wants from the programme this period (growth,
  efficiency, new-customer share, category push).
- **Preferred and deprioritised partners** — channel types to grow (content, loyalty,
  influencer) versus ones to limit or avoid, and why.
- **Brand safety and compliance** — trademark-bidding rules, coupon and incentive
  policy, anything that must never happen.
- **Seasonal focus** — campaigns, peak periods, and dates that change what "normal"
  looks like.
- **Reporting voice and cadence** — how this client likes to receive updates and how
  often.
- **What good looks like / what to escalate** — the judgement calls Claude should make
  when summarising and the things a human must hear about immediately.

### `KPI.md`

The measurable targets and thresholds that turn a generic delta into a verdict:

- Per-period targets — revenue, conversions, EPC, AOV — by programme or network where
  it matters.
- Health limits — acceptable reversal rate, minimum approval rate.
- Alert thresholds — e.g. "flag any programme down more than 15% week-over-week,"
  "reversal rate above 8%."
- Budget and payout ceilings the client has set.

### Storage

The files live locally, keyed by the **same brand slug used in
[`brands.json`](../../src/shared/brands.ts)** so a client's strategy binds directly to
its existing brand-to-network bindings:

```
$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/Strategy.md
$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/KPI.md
```

`$AFFILIATE_MCP_CONFIG_DIR` defaults to `~/.affiliate-mcp` — the same root, and the same
local-first, read-fresh-on-each-call, atomic-write conventions used by
`src/shared/brands.ts`. Files stay on the user's machine; nothing is uploaded.

### Capture and editing — by chat

A future **client-onboarding skill** owns these files. The flow:

1. Claude interviews the operator conversationally about a client ("What is Acme trying
   to achieve this quarter? Which partners matter? What would you want flagged?").
2. Claude drafts `Strategy.md` and `KPI.md`, shows them, and confirms before writing.
3. From then on the files are editable purely by chat — "raise Acme's Q3 revenue target
   to £400k," "treat cashback as deprioritised for Globex," "add a reversal alert above
   10%." Claude rewrites the relevant section and saves.

Because the record is plain markdown, the operator can also open and edit it directly;
chat is the convenience, not the only path.

## How the recorded strategy is used (the payoff)

This is sketched only, to show why recording matters — it is not designed here.

Once the files exist, the existing skills read them at run time and judge actuals against
*this client's* plan rather than generic deltas:

- `KPI.md` supplies the targets and thresholds, so the anomaly, rollup, and report skills
  can say "down 18% but still 6% ahead of the quarterly target" or "reversal rate breached
  the 8% line you set," instead of a bare percentage.
- `Strategy.md` supplies priorities and voice, so a brief leads with what the client cares
  about, stays quiet about channels they have deprioritised, and frames suggested next
  actions in the client's own terms.

## Roadmap

Matching the repo's "prove it before you abstract it" ethos:

1. **P1 — this document.** Define the strategy-recording model.
2. **P2 — the next build.** Per-client `Strategy.md` and `KPI.md` files plus the
   capture-by-chat onboarding skill.
3. **P3.** Wire the existing anomaly, rollup, and report skills to read `KPI.md` and
   `Strategy.md`.
4. **P4 and beyond — deferred, designed later.** Delivery autonomy and "permission
   skipping," scheduled sends, and optional output sinks.

There is **no execution / network-write phase** — that is out of scope by design.
