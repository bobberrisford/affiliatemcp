# `scripts/`

Generators and validators run via `tsx`. Not shipped to the npm
package; used during development and CI.

- `validate-network-json.ts` — schema check on a network's
  `network.json`, plus a live diagnostic run if the adapter is
  registered. Invoked as `npm run validate:network -- <slug>`.
- `generate-readme-table.ts` — regenerates the network table between
  the `AFFILIATE_MCP_NETWORK_TABLE_START`/`END` markers in `README.md`
  from each adapter's `network.json`. Invoked as `npm run generate:readme`.
- `generate-report.ts` / `report-data.ts` — regenerate `REPORT.md`
  from each adapter's `network.json` and the corresponding
  `docs/findings/<slug>.md`. Invoked as `npm run generate:report`.
- `generate-report-image.ts` — render the report summary table to
  PNG (needs Playwright).
- `generate-release-card.ts` — render a branded 1200×627 LinkedIn
  "release card" PNG plus ready-to-paste post copy for a release.
  Invoked as `npm run generate:release-card -- --version vX.Y.Z
  --change "…" [--new-network "…"] [--notes notes.md]`. Outputs to
  `docs/images/release-card.png` and `docs/images/release-post.txt`
  (PNG needs Playwright; the post copy is always written). See
  `docs/product/linkedin-release-posts.md` for the why and the workflow.
