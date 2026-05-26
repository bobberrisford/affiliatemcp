# Setting up affiliate-mcp with Awin (advertiser side) (estimated 6 minutes)

This guide walks you through the credentials affiliate-mcp needs to read
your Awin **brand / advertiser** account — the side of Awin that runs
programmes other publishers promote, not the publisher side that earns
commissions on a programme.

You will end up with one value written to `~/.affiliate-mcp/.env`:
`AWIN_ADVERTISER_API_TOKEN`.

Awin uses an OAuth 2.0 bearer token sent as
`Authorization: Bearer <token>` on every request. The adapter is
**read-only**: the HTTP client refuses any non-GET method, as
defence-in-depth against an accidentally introduced write call. The
Awin advertiser surface exposes mutation endpoints (Conversion API,
transaction amendment, Create Offers), so this guard matters.

## The same token usually works for both publisher and advertiser sides

Awin tokens are user-scoped, not account-scoped. One token can address
every Awin account (publisher or advertiser) the underlying user is
linked to. If you have already configured the publisher Awin adapter
(`AWIN_API_TOKEN`), the wizard will surface that existing value when it
prompts for `AWIN_ADVERTISER_API_TOKEN` and let you confirm or paste a
different one. We do **not** auto-copy: explicit confirmation keeps the
wizard's behaviour predictable, and you may prefer per-surface
separation for audit reasons.

## Prerequisites

- An Awin **advertiser** account on the **Accelerate** or **Advanced**
  plan. Awin's advertiser API is gated to those two plans; brands on
  the Entry-tier plan will appear in your account list but return
  401/403 when the adapter tries to fetch data for them.
- A user sign-in at [https://ui.awin.com/](https://ui.awin.com/) (or
  [https://members.awin.com/](https://members.awin.com/) — same
  credentials).
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Steps

1. Sign in to Awin at [https://ui.awin.com/](https://ui.awin.com/).
2. Open **Toolbox → API Credentials** in the dashboard.
3. Click *Generate Token* (or *Rotate Token* if you have an existing
   one). Awin shows the value only once — copy it immediately.
4. Run `npx affiliate-networks-mcp setup`, select **Awin (advertiser)**
   when prompted, and paste the token. The wizard runs `GET /accounts`
   to confirm the token authenticates and to count how many advertiser
   accounts it addresses.

## Brand discovery

`listBrands` calls `GET /accounts`, filters `type === "advertiser"`,
and returns one `DiscoveredBrand` per account. Every advertiser account
is reported with `apiEnabled: true`.

**Why no per-brand probe?** Awin enforces a hard rate limit of **20 API
calls per minute per user**. An agency with 18 brands would consume the
entire rate budget on a per-brand probe before any real work could
happen — leaving the operator staring at queued retries for the next
minute. The adapter trades probe-time correctness for budget
conservation: when the operator later registers a specific brand whose
plan does not grant API access, the wizard's brand-registration
sub-flow surfaces a clear "found in your portfolio but not
API-accessible — upgrade or skip" message, and you can move on.

If Awin ever exposes a per-account `tier` or `apiEnabled` flag on the
`/accounts` response we will flip the heuristic to read that directly;
the adapter has a `// TODO(verify)` for the eventuality.

If `listBrands` fails (e.g. transient `/accounts` outage) or returns
an empty list the wizard surfaces the reason and drops into a manual-
entry sub-flow that prompts for `(slug, advertiser id, display name)`
tuples — the same path documented for the CJ advertiser at
`docs/networks/cj-advertiser.md`. The manual path is also a fine way
to register Entry-tier brands while you wait for the upgrade — the
binding lives in `brands.json` independent of API access.

## Rate limiting

The 20-calls-per-minute limit is enforced both by Awin's edge and by
this adapter's client (a process-wide token bucket at 20 requests per
60 seconds, keyed per token). Calls that exceed the budget **queue**
rather than fail fast. Consequence:

- A typical operation (verify-then-list-something) completes
  immediately.
- Bursty multi-brand fan-out (e.g. running `getProgrammePerformance`
  across 30 brands in one session) will appear to "stall" for several
  seconds while the bucket drains. This is by design — the alternative
  is a flapping `rate_limited` error the user can't act on.
- Long-running fan-outs can still hit the outer operation timeout. If
  a single call's budget wait would exceed `timeoutMs`, the resilience
  layer fires its `timeout` envelope, which is the right user-facing
  signal: "we waited as long as you allowed".

## Known limitations

- **Read-only at v0.1.** The HTTP client refuses any non-GET method.
  To enable writes a future PR must lift the guard explicitly.
- **20 calls per minute per user.** Bursty operations queue.
- **Plan gate.** Advertiser API access is restricted to the
  Accelerate / Advanced plans. Entry-tier brands appear in `listBrands`
  but data endpoints reject.
- **`listProgrammes` is synthetic.** Awin programmes are configured in
  the UI and not enumerable via the API on every tenant; the adapter
  returns one Programme per advertiser id resolved from the call
  context. Currency defaults to `GBP`.
- **`declined` maps to `reversed`.** Awin's `declined` commission
  status is canonically a transaction reversal in our domain model.
- **Report column aliases.** Awin's per-publisher report has returned
  slightly different column sets per tenant; the transformer reads
  multiple aliases (`pendingNo`/`pendingNumber` etc.) and treats
  missing fields as zero. `// TODO(verify)` against a live Accelerate
  tenant.

## Common failures

### `401 Unauthorized` when validating

Either the token was copied incorrectly or it has been revoked.
Re-open *Toolbox → API Credentials* in the Awin dashboard and
generate a fresh token.

### `429 Too Many Requests`

You blew the 20-per-minute budget. The adapter normally queues you
through this — if you see a raw 429 envelope, either you bypassed the
client (don't) or the budget is shared with another process using the
same token.

### `404 Not Found` on `/advertisers/{id}/...`

The token authenticates but does not have access to the requested
advertiser. Likely causes: the brand is on the Entry-tier plan
(upgrade or skip), or the `networkBrandId` in `brands.json` is wrong
(check it against the `/accounts` response).

### Adapter refuses a write operation

This is by design. The Awin advertiser adapter is read-only at v0.1.
If you need to amend a transaction or post a server-side conversion,
do it via the Awin dashboard or a custom client until a future PR
lifts the guard.
