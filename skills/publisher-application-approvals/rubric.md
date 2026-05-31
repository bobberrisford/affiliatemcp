# Publisher appropriateness rubric

This is the **default** rubric the `publisher-application-approvals` skill applies when
deciding whether to approve, reject, or escalate a publisher's application. It is meant to
be **edited** — tune the gates, signals, and thresholds to your network's and advertisers'
policies.

The rubric is the contract. Every decision the skill makes must cite the specific gate or
signal that drove it, and the skill must **escalate rather than guess** when evidence is
thin.

## How a verdict is reached

Two tiers, evaluated in order:

1. **Hard gates** — pass/fail. **Any** failure → `reject`.
2. **Soft signals** — judged once all hard gates pass. They decide between `approve` and
   `escalate`.

### Decision policy (tune the thresholds here)

- All hard gates pass **and** no soft-risk flags raised → **`approve`**.
- Any hard gate fails → **`reject`**.
- Hard gates pass but soft signals are weak, mixed, or uncertain — or the evidence needed to
  judge a gate or signal is missing — → **`escalate`**.

"Clear-cut" (the only verdicts `auto` mode is allowed to action) means: a clean pass of all
hard gates with no soft-risk flags (approve), or an unambiguous hard-gate failure (reject).
Everything else escalates.

## Hard gates (any fail → reject)

- **Live, reachable website.** The promotional URL resolves to a working site. Dead,
  parked, "coming soon", or unreachable → fail. (No URL at all → escalate unless another
  gate clearly fails.)
- **Relevant to a plausible advertiser.** The site's content maps to a category an
  advertiser on the network would plausibly want. Wholly unrelated or incoherent → fail.
- **Permitted promotional methods.** No prohibited methods: adware/toolbars, cookie-stuffing,
  forced clicks, malware, or incentivised/cashback/voucher activity where the network or
  advertiser disallows it. Detected prohibited method → fail.
- **No trademark / brand-bidding abuse signals.** No evidence of bidding on advertiser brand
  terms or passing off as the brand. Clear signal → fail.
- **Genuine content, not made-for-affiliate.** Not thin, scraped, spun, AI-spam, or a
  link-farm with no real audience or value. Clear signal → fail.
- **Complete, non-fraudulent application.** Required fields present and coherent; no signs of
  a fake or duplicate/fraudulent account. Clearly incomplete or fraudulent → fail.

## Soft signals (decide approve vs escalate)

Judged only after all hard gates pass. A weak, mixed, or unverifiable picture here →
escalate.

- **Content quality and freshness** — substantive, maintained, recently updated.
- **Audience and geographic fit** — audience/region aligns with the network's advertisers.
- **Traffic-source transparency** — declared sources are plausible and disclosed, not vague
  or evasive.
- **Niche relevance** — focused on a coherent vertical rather than scattershot.
- **Professionalism** — credible presentation, working contact details, no spam hallmarks.

## Notes

- This default is Awin-oriented but network-neutral in shape. Add network- or
  advertiser-specific rules as needed.
- When you tighten a gate (e.g. disallow all cashback), expect more `reject`s; when you
  raise the soft-signal bar, expect more `escalate`s. Both are safe directions — the skill
  only auto-actions clear-cut cases.
- If you want different rules per advertiser/programme, split this into per-programme rubric
  files and point the skill at the right one (deferred in the first version).
