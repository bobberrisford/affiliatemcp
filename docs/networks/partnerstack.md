# PartnerStack (partner side)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Apartnerstack%22)

Setup guide for the `partnerstack` adapter, which integrates with the
PartnerStack **Partner API** — the view a partner (publisher) has of their own
partnerships and the rewards they have earned. If you run a partner programme as
a brand, use the `partnerstack-advertiser` adapter instead.

Status: **experimental**. The adapter is built against the documented Partner
API but has not yet been validated end to end against a live partner account.
See "Known limitations" below.

## Prerequisites

- A PartnerStack partner account with API access.
- A Partner API key (generated from your account settings — see below).

No manual approval step is required: the key works as soon as it is generated.

## Credentials needed

- `PARTNERSTACK_API_KEY` — your Partner API key. Sent as a Bearer token on every
  request.

## Setup steps

1. Log in to your PartnerStack partner account.
2. Open your user menu (top-right) → **Settings**.
3. Open the **API keys** section.
4. Generate a key and copy the value.
5. Run `affiliate-networks-mcp setup partnerstack` and paste the key when
   prompted, or set `PARTNERSTACK_API_KEY` in `~/.affiliate-mcp/.env`.

## Common failures

1. **401 Unauthorised** — the key is wrong, revoked, or copied with surrounding
   whitespace. Regenerate it from Settings → API keys and re-run setup.
2. **Empty programme list** — a valid key on an account with no active
   partnerships returns an empty list rather than an error. Confirm you have
   joined at least one programme in the PartnerStack dashboard.
3. **Unexpected amounts** — reward amounts are interpreted as minor units
   (cents) and divided by 100. If your figures look 100× off, this is the unit
   assumption; raise an issue with a scrubbed sample so it can be confirmed.

## Known limitations

- Click-level data is not exposed via the Partner API; `listClicks` is
  unsupported.
- `generateTrackingLink` is unsupported. PartnerStack issues partner links
  itself; there is no documented per-destination deep-link construction.
- Reward amounts are assumed to be minor units (cents). The unit has not been
  confirmed against a live account.
- `partnership` and `reward` field names are read defensively and have not been
  confirmed against a live partner account. The verbatim upstream payload is
  preserved on `rawNetworkData` for every record.
- `getProgramme` filters the `/partnerships` list client-side; the Partner API
  has no documented single-partnership endpoint.

## Verifying

```
affiliate-networks-mcp test partnerstack
```

This runs the live diagnostic — the same engine as
`npm run validate:network -- partnerstack`. A passing diagnostic against a real
account is the verification contract for promoting the adapter beyond
`experimental`.
