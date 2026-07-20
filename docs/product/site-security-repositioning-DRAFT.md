# DRAFT — repositioning `site/security.html` for the live hosted tier

> Status: **draft for Rob's review. Do not publish.** Kept in `docs/` (not
> `site/`) so nothing deploys. This is public trust/legal copy; it needs Rob's
> sign-off (and possibly a short decision record) before any live edit.

## Problem

`site/security.html` is live and built entirely around "there is no hosted
service". That is now false: the hosted tier is live (`hosted.agenticaffiliate.ai`,
`mcp.agenticaffiliate.ai`), stores encrypted credentials in a vault, and bills
via Stripe. The page therefore makes claims that no longer hold for hosted
users, including:

- Hero lead: "affiliate-mcp is local-first with **no hosted service**: it never
  receives your credentials or affiliate data" (line 70).
- "There is **no hosted service** and no account to create with us" (line 77).
- "**No multi-tenant server**, no shared database, no vendor-held copy of your
  data to be breached" (line 80).
- Sub-processors: "None for credentials or affiliate data" (line 111).
- Compliance: "there is no hosted service or vendor-held data to certify, and
  **we are not a processor of your affiliate data** because it is never sent to
  us" (line 121).

For a page whose whole job is to answer brand/agency security reviews honestly,
this is a trust and (for GDPR) a legal exposure.

## Approach: split every claim into two tiers

Keep the local tier's strong claims exactly as they are — they remain true and
are a genuine differentiator — and add an honest hosted-tier column/row beside
each. The framing: **local stays local; hosted is opt-in, bring-your-own-key,
and does introduce a processor relationship, described plainly.** This mirrors
the already-accurate hosted section of `PRIVACY.md` and the custody decision
(`2026-07-12-hosted-credential-custody.md`).

## Proposed copy

### Hero lead (replaces line 70)

> Brands and agencies run security reviews before they trust a tool.
> affiliate-mcp comes in two forms. The **local server** is bring-your-own-keys
> and runs on your own machine — it never sends your credentials or affiliate
> data to us, so most of the questionnaire does not apply. The optional
> **hosted tier** runs your reports for you and, to do that, stores your network
> keys encrypted on our infrastructure — so for hosted we answer the
> questionnaire in full below.

### Bullet list (replaces the `plist`, lines 76–81)

> - **Local:** runs as a process on your own machine, under your own account.
>   Your credentials and affiliate data are never sent to us.
> - **Local:** the security boundary is your machine and your API keys, not a
>   vendor's infrastructure.
> - **Hosted (opt-in):** your network keys are encrypted and stored so reports
>   can run while your machine is off. Keys are decrypted only at call time, in
>   memory, to serve your own requests, and are never given to the AI client.
> - **Hosted (opt-in):** self-serve export of everything and hard delete at any
>   time. Deletion is complete, not a soft flag.

### Q&A rows (replace / add)

- **Where customer data is stored** — add: "Hosted: network credentials and
  OAuth tokens are encrypted and stored on Cloudflare; per-tenant brand and
  strategy context alongside; for paid subscribers, one billing email. Nothing
  else."
- **Does the vendor receive data or credentials?** — add: "Hosted: yes, by
  design — you enter your keys into the encrypted dashboard so the service can
  run your reports. They are encrypted at rest and used only to serve your own
  requests."
- **Sub-processors** — replace "None…" with: "Local: none (telemetry aside).
  Hosted: Cloudflare (compute, storage, and the credential vault), Stripe
  (billing), and Resend (sign-in and digest email). Your affiliate data is
  fetched live from the networks' APIs and not retained beyond your reports."
- **Encryption at rest** — add: "Hosted credentials use envelope encryption
  (per-user AES-256-GCM data key, wrapped by a master key). The MVP wraps the
  master key with a Cloudflare Worker secret rather than an external KMS; the
  vault threat model documents what that does and does not protect against."
  *(Rob: decide how much of the Worker-secret limitation to state publicly.)*
- **Data retention and deletion** — add the hosted self-serve export + hard
  delete flow.
- **Compliance (SOC 2, ISO 27001, GDPR)** — replace the "not a processor"
  claim with: "Local: no vendor-held data to certify. Hosted: we act as a
  processor of the credentials you store with us; there is no SOC 2 / ISO 27001
  certification yet. See the privacy policy and the hosted custody decision for
  the current contract." *(Rob/legal: GDPR processor wording, DPA availability,
  and any certification roadmap.)*

## Open questions for Rob (before this goes live)

1. How much of the **Worker-secret master-key** limitation to disclose publicly
   vs. link to the threat model.
2. **GDPR/DPA**: confirm the processor framing and whether a DPA is offered to
   hosted customers.
3. Whether a short **decision record** should precede the live edit (public
   trust-surface change) — recommended.

## Recommendation

Land a small decision record accepting the two-tier security framing, then apply
this copy to `site/security.html` (and the meta descriptions on lines 7/12/21,
which also say "no hosted service") in one reviewed PR. Do not edit the live
page until then.
