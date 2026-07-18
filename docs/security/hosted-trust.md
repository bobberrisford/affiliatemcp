# Hosted tier: trust page

This page states what the hosted tier of affiliate-mcp stores, how it is
encrypted, who can reach it, where it runs, and how you get your data out or
erase it. It is the public trust statement the credential-custody decision
requires before the first paying hosted customer
(`docs/decisions/2026-07-12-hosted-credential-custody.md`, item 6). It is
written to be accurate and complete rather than reassuring: where the design
has a real limit, this page names it.

The local server is unchanged by any of this. Run affiliate-mcp on your own
machine and your credentials and affiliate data never leave it; the local path
stays free and complete. Everything below applies only if you deliberately opt
into the hosted tier.

## What the hosted tier is

A cloud-hosted way to use affiliate-mcp without running it yourself: you sign
in by email, store your affiliate network credentials in an encrypted vault,
connect an MCP client (Claude, ChatGPT, or another) over an authenticated
connector, and — on paid tiers — receive scheduled digest emails. It runs on
Cloudflare Workers and Cloudflare Containers.

## What is stored

- **Your affiliate network API credentials and OAuth tokens**, encrypted (see
  below). One encrypted record per connected network.
- **Per-tenant brand and client-strategy context** you create through the
  tools.
- **A hashed email identity.** Your email address is stored as a one-way,
  domain-separated hash used only to look your account up at sign-in; the
  plaintext address is not kept in the identity store.
- **For paying subscribers only, one plaintext billing email**, held with the
  subscription record (tier and status). It is used for exactly two things:
  Stripe billing correspondence and delivering the scheduled digest emails paid
  tiers include. Never for marketing or analytics. It is deleted with the
  account.

Nothing else is stored. Browser session credentials are never held; browser-
driven operations and write actions stay on the local path only, until a
separate hosted-action safety contract exists. The hosted tier is read-only in
scope.

These live in three deliberately separate Cloudflare KV namespaces: an identity
store (account id and the email-hash lookup, no affiliate credentials or data),
an encrypted vault (the wrapped per-user key and one encrypted blob per
network), and a billing store (tier, status, and the one billing email).

## How it is encrypted

Envelope encryption, using WebCrypto only:

- A random AES-256-GCM **data key** is generated for you on your first connected
  network and reused across your networks. Every stored credential is encrypted
  under it with a fresh initialisation vector.
- That data key is never written to storage unencrypted. It is **wrapped** by a
  master key before storage, and only the wrapped form is persisted.
- Credentials are **decrypted only at call time**, in memory, to serve the
  request that needs them. Plaintext is never written to storage and never
  cached.

### The honest limit

In the current implementation the master key that wraps your data key is a
Cloudflare Worker secret, not an external key-management service (KMS). Stated
plainly:

- **A leak of the vault storage alone reveals nothing** — the credentials are
  under two layers of ciphertext, and the master key is not in that store.
- **A compromise of the running Worker process** could reach the master key and
  any data in flight, because that process legitimately holds the master key to
  do its job.
- **A compromise of the Cloudflare account** that controls both the storage and
  the Worker secret could reach everything.

This is envelope encryption on managed infrastructure, not KMS-backed custody in
the usual sense. The maintainer reviewed and accepted this design for the
current stage on 2026-07-14; the code carries a `MasterKeyProvider` seam so a
KMS-backed master key (where the key never enters the Worker process) can drop
in without re-encrypting stored credentials. The full write-up is in
`hosted/README.md` ("Vault threat model"). Revisit before any team-tier or
formal-compliance work.

## Who can access it

A stored credential serves only its owner's own requests and their own
scheduled jobs. It is never used for aggregation across users, never for
analytics, and never for any purpose beyond serving its owner. There is no
cross-tenant access path.

## Where it runs

Cloudflare Workers (the auth, vault, billing, and digest service) and
Cloudflare Containers (the MCP transport that runs the network adapters), on
Cloudflare's infrastructure. No affiliate data is copied to any other host.
Networks see the same API calls your own dashboard would make.

## Getting your data out, and deleting it

The custody contract gives you self-serve control at any time:

- **Export** everything held about your account — the account record, which
  networks you have connected and when, and your subscription and billing
  state. The export lists your connected networks as metadata; it never
  includes a stored credential value, so an export file cannot be used to act
  as you. (Delivered by the account-export route; use the per-network reveal in
  your dashboard if you need a live credential back.)
- **Delete** your account completely at any time. Deletion removes the encrypted
  credential data, the wrapped key protecting it, the account record, the email-
  hash lookup, and the subscription record including the billing email. It is a
  hard delete, not a soft flag: once it runs there is nothing left to decrypt
  and nobody left to email. Cancelling the live Stripe subscription itself is a
  separate step on Stripe's side, documented in the deletion runbook.

## If something goes wrong

The maintainer owns the security, legal, and privacy contract for hosted
custody. On any suspected compromise, affected users are notified promptly and
within applicable GDPR timelines. The internal incident and disclosure
procedure is `docs/security/hosted-incident-response.md`; report a suspected
vulnerability through the channel in [`SECURITY.md`](../../SECURITY.md).

## Related

- [`PRIVACY.md`](../../PRIVACY.md) — the retention and data-handling policy,
  hosted section.
- `hosted/README.md` — the full technical spec, including the vault threat
  model.
- `docs/decisions/2026-07-12-hosted-credential-custody.md` — the accepted
  custody decision this page reports.
- `docs/security/hosted-key-rotation.md` — how secrets are rotated.
