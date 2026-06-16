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
- `social-video.mjs` / `social-posts.mjs` — render LinkedIn-ready 4:5
  social posts (per-beat PNGs plus an MP4) from the design system,
  following `docs/product/social-video-playbook.md`. Run as
  `node scripts/social-video.mjs <post-id>`. Needs Playwright's Chromium
  and ffmpeg (`npm i --no-save playwright ffmpeg-static`); set
  `CHROME_BIN` if the browser lives outside the default path. Output
  lands in `docs/product/social-assets/<post-id>/`.
