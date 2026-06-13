# Cross-network normalisation fields: the rollout pattern

`src/shared/types.ts` carries five additive, optional normalisation fields.
They were merged inert (no adapter populated them). The Awin reference adapters
(`src/networks/awin/` for publisher, `src/networks/awin-advertiser/` for
advertiser) are the first to populate them. This note is the copyable pattern
for the remaining adapters; each subsequent rollout PR should follow it for one
network at a time.

The fields are optional and additive. Populating them must not change any
existing field, alter tool output shape beyond adding the new optional fields,
or break any existing test. A consumer must never infer meaning from a field's
absence during the rollout: absence means "not yet migrated", not "the network
has no such concept".

## The five fields

| Field | Type | Lives on |
| --- | --- | --- |
| `networkTimezone` | `NetworkMeta` | the adapter's `META` object |
| `merchantKey` | `Programme`, `Transaction` | per-row transform |
| `merchantKeySource` | `Programme` | per-row transform |
| `statusRaw` | `Transaction` | per-row transform |

### 1. `meta.networkTimezone` — and who owns naïve→UTC

Declare the IANA timezone the network reports in when its API returns naïve
timestamps (no `Z`, no `±HH:MM`). For Awin that is `Europe/London`, which is
also the `timezone` query parameter the publisher adapter sends.

The contract is strict: **the adapter owns the naïve→UTC conversion.** A naïve
string parsed with `Date.parse` uses the host machine's timezone, so the same
payload produces different instants on a London laptop and a UTC CI box. That is
lossy and the consumer cannot recover from it. The adapter must interpret the
wall-clock reading in `networkTimezone` and emit canonical UTC via
`toISOString()`. `networkTimezone` is documentation of what the adapter already
did, not a hint for the consumer to reinterpret a returned timestamp.

Pattern (see `parseAwinTimestamp` / `zonedNaiveToUtcIso` in the publisher
adapter, mirrored as `parseAwinDate` / `zonedNaiveToUtcIso` in the advertiser
adapter):

- If the upstream timestamp is already offset-qualified (`…Z` or `…±HH:MM`),
  parse it as the absolute instant it names and pass it through verbatim.
- If it is naïve, interpret the wall-clock reading in `meta.networkTimezone` and
  convert to UTC. The Awin adapters do this with `Intl.DateTimeFormat` and no new
  dependency: guess the instant as if the wall-clock were UTC, ask `Intl` what
  that instant looks like in the zone, and shift by the measured offset. This
  handles DST (BST/GMT) correctly.

Route the age calculation (`computeAgeDays`) through the same parser so the age
is measured against the same canonical instant the adapter emits.

If a network's API is genuinely always offset-qualified, you may still declare
`networkTimezone` to document the reporting zone, but make the naïve path
correct anyway: it is cheap insurance against tenant-by-tenant drift, which Awin
exhibits (documented offsets, naïve fixtures).

### 2. `merchantKey` + `merchantKeySource` on `Programme`

A stable cross-network identity for the underlying merchant, so a consumer can
group "Acme on Awin" with "Acme on CJ" without string-matching display names.

Until the shared brand-resolver follow-up lands, an adapter populates a
best-effort fallback from its own data, and **must not** claim `resolver`
provenance (that source is reserved for the confident resolver-supplied key):

- `fallback-domain` — the registrable domain (eTLD+1, lowercased, `www.`
  stripped) of the merchant's `advertiserUrl`. Most reliable across networks.
- `fallback-name` — a slugified display name, used only when no usable URL is
  present.
- `none` — neither a URL nor a usable name was available; leave `merchantKey`
  absent and set the source to `none`.

Use a heuristic domain extractor (last two labels, or three for `co.uk`-style
two-part TLDs), not a Public Suffix List lookup: the PSL-accurate version
belongs in the shared resolver, and a `fallback-domain` key is explicitly
allowed to be superseded later by a `resolver` key. Do not add a dependency for
this.

For synthetic programmes (e.g. the advertiser adapter's single placeholder row),
set `merchantKeySource: 'none'` rather than slugifying a placeholder name like
`"Awin advertiser 100001"`, which would manufacture a key that matches nothing.

### 3. `merchantKey` on `Transaction`

The same cross-network identity, carried onto the transaction. The shared type
describes this as inherited from the parent `Programme.merchantKey` at the tool
layer; when the adapter transforms transactions in isolation it derives the key
from whatever merchant signal the transaction row carries (Awin transactions
expose the merchant landing `url`, and the publisher adapter also has
`advertiserName`), using the same helper as the programme transform so a
transaction's key stays consistent with its programme's.

### 4. `statusRaw` on `Transaction`

The verbatim upstream status token before it was mapped to the canonical
`TransactionStatus` enum. This lets a consumer re-classify rows that collapsed
into `status: 'other'` (e.g. Impact `LOCKED`, Tradedoubler `A`).

Set it to exactly what the network returned. Two Awin nuances worth copying:

- The publisher adapter derives canonical `paid` from a `paidToPublisher` flag
  rather than a status string. When that flag is the only signal, record
  `paidToPublisher` as the raw token so `statusRaw` stays honest about what the
  API actually sent; otherwise record the verbatim `commissionStatus`.
- The advertiser adapter has no derived `paid` flag, so `statusRaw` is simply the
  verbatim `commissionStatus`.

## Test checklist for a rollout PR

Extend the adapter's tests under `tests/networks/<slug>/` to assert, using the
existing fixtures:

- [ ] `meta.networkTimezone` is the expected IANA zone.
- [ ] Naïve upstream timestamps convert to the correct UTC instant (pick a
      summer and a winter fixture row so a DST bug is visible).
- [ ] Offset-qualified timestamps pass through verbatim.
- [ ] `statusRaw` carries the verbatim upstream token for each status, including
      rows that map to canonical `other`/`paid`/`reversed`.
- [ ] `Programme.merchantKey` / `merchantKeySource` for the domain, name, and
      none paths.
- [ ] `Transaction.merchantKey` is derived and consistent with the programme.

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and
`npm run validate:network -- <slug>`. Do not modify `src/shared/` — the contract
is already merged. Do not touch another network's adapter in the same PR.
