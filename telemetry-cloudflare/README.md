# Telemetry Cloudflare deployment

First-party backend for explicitly opted-in, once-daily usage summaries and
aggregate npm/GitHub adoption metrics.

## Deploy

1. Create the D1 database and replace `REPLACE_WITH_D1_DATABASE_ID` in
   `wrangler.jsonc`.
2. Run `npm install`, then `npm run db:migrate`.
3. Add the authenticated traffic token with
   `npx wrangler secret put GITHUB_TOKEN`. It needs read access to repository
   traffic statistics.
4. Deploy with `npm run deploy`.
5. Route `telemetry.affiliate-mcp.com` to the Worker.
6. Protect the dashboard and `/api/dashboard` with Cloudflare Access.
7. Keep Workers observability/logging disabled so request IPs and payloads are
   not retained by this project.

The Worker validates a closed payload schema, applies Cloudflare's rate-limit
binding, writes short-lived raw dimensions to Analytics Engine, and stores
aggregate daily rollups in D1. `install_activity` retains rotating monthly IDs
for at most 35 days solely to estimate opted-in monthly active installations.
