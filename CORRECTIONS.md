# Corrections

## Why this file exists

[`REPORT.md`](./REPORT.md) makes factual claims about each network's API —
which operations work, which are unsupported, what the latency looks like,
which fields are flaky. Some of those claims will turn out to be wrong.
APIs change. Documentation lags. A field that was missing yesterday is
populated today.

This file is how we set the record straight.

If you spot a factual error in `REPORT.md`, in a finding under
`docs/findings/<slug>.md`, in a setup doc under `docs/networks/<slug>.md`,
or in any in-code description of a network's behaviour — please file a
correction.

## How to file a correction

You have two options. Either works; the second is faster if you already
know what the fix should look like.

### Open an issue

Use the [`correction.yml`](./.github/ISSUE_TEMPLATE/correction.yml) issue
template. It asks for:

- The file and line (or section) that contains the claim.
- What the document currently says.
- What it should say.
- A source: a link to the network's official documentation, a dashboard
  screenshot, an HTTP trace, a changelog entry, or anything else that lets
  a maintainer verify the claim independently.

### Open a PR

Edit `docs/findings/<slug>.md` (the source of truth for `REPORT.md`) — not
`REPORT.md` itself. Add or correct the relevant finding, citing your
source in the evidence paragraph. Run `npm run generate:report` and
include the regenerated `REPORT.md` in the same PR. Use the default PR
template; flag the correction in the summary.

## Network claim process

A "claim" is the formal statement that a particular network adapter is
fit for production use. The process for promoting an adapter from
`claim_status: partial` to `production` is documented at
[`docs/network-claim-process.md`](./docs/network-claim-process.md).

If you disagree with a current claim — for example, you believe an
adapter should be downgraded from `production` to `partial` because a
field has gone flaky — open a correction issue with the evidence. The
maintainers will downgrade pending investigation.

## Editorial policy

`REPORT.md` is the project's editorial position. The rules:

- **Matter-of-fact tone.** No snark, no marketing, no celebratory
  language. Describe what is, not what we wish.
- **No comparisons.** Networks are not ranked or scored against each
  other; each is reported on its own merits.
- **Claims must be verifiable.** Every assertion should be backed by a
  link, a screenshot, an HTTP trace, or a reproducible test fixture.
- **No anecdotes without evidence.** "Awin sometimes returns empty pages"
  is not a finding; "Awin returns an empty `data` array with HTTP 200
  when the publisher has zero programmes in window — see fixture X" is.
- **UK spelling, throughout.**

If a correction touches on tone (rather than fact), say so explicitly in
the issue. Tone changes are reviewed against this section.
