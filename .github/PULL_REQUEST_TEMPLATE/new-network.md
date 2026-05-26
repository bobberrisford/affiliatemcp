<!-- Use this template when adding a new network adapter. -->
<!-- ?template=new-network.md -->

## Summary

A one-line summary of the network being added and its current claim status
(expected to be `partial` for a first landing).

## Which operations are live

List the seven canonical operations and mark each as **live** or
**NotImplementedError**. Operations the network does not support must return
the documented unsupported envelope rather than throwing.

- `list_programmes`:
- `get_programme`:
- `list_transactions`:
- `get_earnings_summary`:
- `list_clicks`:
- `generate_tracking_link`:
- `verify_auth`:

## Closing checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run validate:network -- <slug>` passes
- [ ] No credentials in committed files (no real tokens, no real account ids)
- [ ] No `console.log` calls in `src/`
- [ ] No `@ts-ignore` or `as any` without an inline comment explaining why
- [ ] Tool descriptions follow PRD §5.5 (three sentences: what, when, returns/pairs)
- [ ] Error messages follow PRD §4.1 (named network, named operation, verbatim body)
- [ ] UK spelling throughout
- [ ] README network table regenerated (`npm run generate:readme`)
- [ ] `REPORT.md` regenerated if findings were touched (`npm run generate:report`)
- [ ] `.github/CODEOWNERS` updated with the new adapter directory
- [ ] Per-network setup doc at `docs/networks/<slug>.md` written (screenshots or placeholders)
- [ ] PR description above names which 7 ops are live vs `NotImplementedError`

## Notes for reviewers

Anything specific you want a maintainer to look at — known limitations,
upstream quirks, areas where you would like a second opinion.
