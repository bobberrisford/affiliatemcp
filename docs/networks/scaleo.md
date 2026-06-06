# Setting up affiliate-mcp with Scaleo (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Ascaleo%22)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Scaleo affiliate account. You will end up with two values written
to `~/.affiliate-mcp/.env`: `SCALEO_BASE_URL` and `SCALEO_API_KEY`.

Scaleo is a tenant affiliate-platform engine: many independently-operated
networks run on the same Scaleo API at their own domain. There is no shared API
host, so the base URL is part of your credentials, not a fixed value built into
the adapter. The same adapter works for any Scaleo-powered network once you
supply its tracking URL.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording is shown; the panel layout can change between releases,
so the location is described alongside.

## Prerequisites

- An affiliate account on a Scaleo-powered network. If you can sign in to the
  network's Scaleo panel and see your offers and reports, you have what you
  need.
- API access enabled on your affiliate profile. This is not self-service: the
  network administrator must turn it on for your account. Allow up to a working
  day for the administrator to action the request.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `SCALEO_BASE_URL` — your network's tracking URL (the API host), for example
  `https://yournetwork.scaletrk.com`. This is the scheme and host only, with no
  path.
- `SCALEO_API_KEY` — your affiliate API key. It is sent as the `api-key` query
  parameter on every request.

## Setup steps

1. Find your tracking URL. As an affiliate, open any offer, go to the
   *Tracking* section, and generate an affiliate tracking link. It looks like
   `https://yournetwork.scaletrk.com/click?o=1&a=1`. The scheme and host portion
   (`https://yournetwork.scaletrk.com`) is your tracking URL. If you are an
   administrator, you can also read it under *Settings* → *General* → *Domain
   for Tracking*.

2. Ask your network administrator to enable API access for your account. They
   open your affiliate profile edit page, turn on the *API Access* switcher, and
   save. Without this step there is no API key to copy.

3. Once API access is enabled, your API key is shown under *Account* → *API*
   (also reachable from *User Settings* in the top-right corner). Copy the key.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Scaleo** when prompted. Enter your tracking URL when the wizard asks for
   `SCALEO_BASE_URL`, then paste the API key when it asks for `SCALEO_API_KEY`.
   The wizard validates the key by listing one offer against your tracking URL.

## What success looks like

The wizard confirms that the key validated against the
`/api/v2/affiliate/offers` endpoint on your tracking URL and writes the two
values to `~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test scaleo` should report `ok` for offers,
transactions, the earnings summary, and clicks. `generateTrackingLink` reports
unsupported (see Known limitations).

## Common failures

### Failure: the wizard reports the API key is invalid

Confirm two things in order. First, that `SCALEO_BASE_URL` is your tracking URL
(`...scaletrk.com` or your network's custom tracking domain) and not the panel
login URL; the API only answers on the tracking host. Second, that the
administrator has enabled the *API Access* switcher on your affiliate profile.
Until that switcher is on, no key exists and the validation fails.

### Failure: requests work but return no data

The API key is scoped to a single affiliate account by the administrator. If you
expected data for a different account, you are using the wrong key. Confirm the
account whose *Account* → *API* page you copied the key from.

### Failure: `SCALEO_BASE_URL` rejected as invalid

Enter the full URL including the scheme, for example
`https://yournetwork.scaletrk.com`. Do not include a path, query string, or
trailing slash. A bare hostname without `https://` is rejected.

## Known limitations

- This adapter was built from public API documentation and has not yet been
  verified against a live Scaleo tenant. Response field names carry defensive
  fallbacks, and monetary amounts are assumed to be major currency units in the
  reported currency.
- The base API host is per-tenant. There is no shared host: you must supply your
  network's tracking URL via `SCALEO_BASE_URL`.
- Affiliate API access is enabled per user by the platform administrator, not
  self-service.
- `generateTrackingLink` is not implemented. A Scaleo click link
  (`/click?o={offer}&a={affiliate}`) requires the affiliate id, which is not
  among the configured credentials, so a correctly-attributed link cannot be
  constructed. Use the per-offer tracking link that Scaleo returns on a
  programme's raw data instead.

## Verifying

```
affiliate-networks-mcp test scaleo
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- scaleo`. The diagnostic engine's pass is the
verification contract.
