# Documentation map

This directory contains product direction, accepted decisions, network setup
guides, and implementation research. Use this map to find the document that
owns a question before editing or reviewing a change.

## Authority order

When documents disagree, use this order:

1. Accepted records under [`decisions/`](./decisions) define settled product,
   architecture, security, distribution, and public-contract choices.
2. Root policies and runbooks define current repository practice:
   [`../PRIVACY.md`](../PRIVACY.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md),
   [`../RELEASING.md`](../RELEASING.md), and [`../AGENTS.md`](../AGENTS.md).
3. Current code, tests, and structured `network.json` manifests define shipped
   behaviour.
4. Product plans and research under [`product/`](./product) provide direction
   and history. They do not override accepted decisions or shipped behaviour.

Proposed decision records are proposals until their status changes to
`Accepted`. Generated documents such as [`../REPORT.md`](../REPORT.md) should
be changed through their source data or generator, not edited by hand.

## Documentation areas

| Area | Purpose | Edit when |
| --- | --- | --- |
| [`decisions/`](./decisions) | Settled and proposed cross-cutting decisions | Recording a decision or updating its status |
| [`product/`](./product) | Product direction, active proposals, historical plans, and research | Clarifying direction or proposal status |
| [`networks/`](./networks) | User-facing credential and setup walkthroughs | Setup steps or network requirements change |
| [`security/`](./security) | Self-serve security and data-handling overview for brands, agencies, and their reviewers | Security posture or data-handling answers change |
| [`findings/`](./findings) | Evidence and implementation findings used by `REPORT.md` | Network research or verified behaviour changes |

Component-specific documentation stays beside the component, for example
[`../desktop/README.md`](../desktop/README.md),
[`../mcpb/README.md`](../mcpb/README.md), and
[`../src/shared/README.md`](../src/shared/README.md).

## Review rules

- State whether a new product document is `Current`, `Proposal`, `Research`,
  `Historical`, or `Superseded`.
- Link to the accepted decision that supersedes an older plan.
- Prefer links to canonical documents over repeating policy or architecture.
- Keep generated outputs and their source material clearly distinguished.
