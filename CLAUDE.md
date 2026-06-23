# Claude Code project instructions

@AGENTS.md

Use the repo-local `delivery-steward` skill for implementation and delivery,
`prepare-for-review` for PR handoff, and `review-pr` for independent review.
For multi-PR work, write the dependency graph and risk gates before coding.
Do not build production foundations or child implementation PRs ahead of an
unresolved decision, even as drafts; discovery and explicitly disposable
prototypes are allowed. Keep Othman's risk-review lane to one PR and use at
most two routine lanes for decision-complete work in disjoint domains. Make
safe scoped corrections and validate them directly instead of handing routine
work back. Never merge without explicit human approval for that specific PR.
When an interaction reveals a concrete delivery-system lesson, include a brief
optional side note with evidence and a proposed improvement; stay silent when
there is no meaningful lesson and keep governance edits out of feature PRs.

## Multi-PR features

A feature too big for one coherent PR ships as multiple linked PRs, never one
mega-PR. Before coding, write the workstream brief (user outcome, dependency
graph, owning domains, risk gates, acceptance proof per PR, stop conditions) in
the first PR or a tracking issue. Land in dependency order: decision PR for
unresolved governance or contracts first, then the smallest foundation with its
first real consumer, then stacked vertical slices, then integration proof. See
AGENTS.md ("For a feature that needs multiple PRs…") for the full protocol.
