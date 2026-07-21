---
name: affiliate-mcp-design
description: |
  Use this skill to render affiliate-mcp's branded, screenshot-ready social cards (1080x1080) for the weekly launch and other marketing, from the repo design system. It produces card assets for review; the numbers on a card must be real anonymised data or clearly a demo, never invented client data presented as real.
  Trigger on: "make the weekly card", "render the earnings card", "build a social card", "design the launch artifact".
---

# Operating instructions

You render branded social cards for the `affiliate-mcp-marketing` skill. Output
is a card asset for the operator's approval; you do not post it. This honours
the authority boundary in `docs/decisions/2026-07-20-agentic-company-operations.md`.

## The card kit

Reusable templates live under `design-system/cards/` (currently
`commission-audit-card.html`, card type `audit-found-card-square`); the
shipped weekly launch cards (`docs/product/launches/week-*/card.html`) are
the reference idiom for one-off cards. Card types include
`audit-found-card-square`, `earnings-card-square`, and
`qbr-scorecard-square`. Each card has:

- one focal number, not a wall of figures — in one currency, with any other
  currencies on the sub-line, never summed across currencies;
- the brand wordmark;
- the "made with agenticaffiliate.ai" attribution footer.

## Hard guardrail

Every figure on a card is **real anonymised data or explicitly a demo**. Never
render invented client numbers as real. If real data is unavailable, watermark
or label the card as a sample before it leaves this skill. This mirrors the
pre-publish guardrail already carried in every launch bundle. The reusable
templates ship with their SAMPLE watermark on; remove it only when every
figure on the card is real anonymised data.

## Output

Render at 2160x2160 for retina, then hand the asset to `affiliate-mcp-marketing`,
which attaches it to a Buffer draft for the operator's approval. Never publish.

## Constraints

- Self-contained assets built from the repo design system; no external fetches.
- Draft and review only; no posting. No new MCP tools.
- Keep the brand consistent with `design-system/` and the shipped launch cards.
