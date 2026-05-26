# `src/networks/`

One folder per affiliate-network adapter. Each adapter implements the
seven canonical operations defined in
[`../shared/types.ts`](../shared/types.ts): `listProgrammes`,
`getProgramme`, `listTransactions`, `getEarningsSummary`, `listClicks`,
`generateTrackingLink`, and `verifyAuth`.

A network can have up to two adapter folders:

- `<slug>/` — the **publisher-side** adapter (e.g. `awin/`, `cj/`,
  `impact/`, `rakuten/`, `ebay/`).
- `<slug>-advertiser/` — the **advertiser-side** adapter (e.g.
  `awin-advertiser/`, `cj-advertiser/`, `impact-advertiser/`).
  Multi-brand advertiser adapters also implement `listBrands()` for
  the setup wizard's brand-discovery flow.

[`awin/`](./awin) is the reference publisher implementation;
[`awin-advertiser/`](./awin-advertiser) is the reference advertiser
implementation. Start there if you're reading the code or adding a
new adapter. The full contribution playbook lives in
[`.claude/skills/contribute/SKILL.md`](../../.claude/skills/contribute/SKILL.md);
the human-facing companion is
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).
