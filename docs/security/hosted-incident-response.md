# Hosted tier: incident and disclosure runbook

The credential-custody decision requires a written incident and disclosure
runbook to exist before launch, not after the first incident
(`docs/decisions/2026-07-12-hosted-credential-custody.md`, item 7). This is that
runbook. It covers a suspected or confirmed compromise of the hosted tier: the
credential vault, the Worker secrets, the identity or billing stores, or the
Cloudflare account that controls them.

The maintainer (Rob) owns the security, legal, and privacy contract for hosted
custody and is the incident owner. Scope is the hosted tier only; the local
server holds none of a user's credentials or affiliate data and is out of scope
for this runbook.

## What counts as an incident

Any of the following is an incident and starts this runbook:

- Suspected exposure of any Worker secret, especially `VAULT_MASTER_KEY` or
  `SESSION_SIGNING_KEY` (see `docs/security/hosted-key-rotation.md` for what each
  protects).
- Unauthorised access to, or exfiltration of, any hosted KV namespace (identity,
  vault, or billing).
- Compromise or suspected compromise of the Cloudflare account, the deploy
  credentials (`CLOUDFLARE_API_TOKEN`), or the CI that can deploy the Worker.
- Any credible report that one user's data was served to another, or that a
  stored credential was used outside its owner's own requests.
- A vulnerability report (via [`SECURITY.md`](../../SECURITY.md)) that plausibly
  allows any of the above.

When unsure whether something qualifies, treat it as an incident until triage
says otherwise.

## Severity

- **Critical** — confirmed or likely exposure of credential plaintext, the vault
  master key, the session signing key, or the Cloudflare account. Assume user
  affiliate credentials are at risk.
- **High** — exposure of a scoped secret (Stripe, Resend, webhook) or of KV
  ciphertext without the master key. No credential plaintext at risk, but
  billing, email, or entitlement integrity is.
- **Low** — a contained issue with no data exposure (for example a vulnerability
  found and fixed before any use).

## Response steps

1. **Declare and record.** The incident owner opens a private, timestamped
   record: what was observed, when, and how it was found. Keep it out of any
   public channel.
2. **Contain.** Stop the bleeding before investigating fully:
   - Rotate the implicated secret immediately per
     `docs/security/hosted-key-rotation.md`. A suspected `SESSION_SIGNING_KEY`
     exposure both invalidates outstanding sessions and needs the email-hash
     re-derivation in that runbook; a suspected `VAULT_MASTER_KEY` exposure needs
     the re-wrap procedure.
     For a suspected Cloudflare-account or API-token compromise, revoke
     `CLOUDFLARE_API_TOKEN`, rotate the account credentials, and review recent
     deploys and audit logs before trusting the running Worker.
   - If containment requires it, take the hosted Worker or transport offline
     rather than leave a live exposure.
3. **Assess scope.** Determine which users and which data are affected, using the
   KV namespaces and the encryption boundaries in
   `docs/security/hosted-trust.md`. Record the basis for the assessment, not just
   the conclusion — vault ciphertext exposed *without* the master key is a
   materially different scope from master-key exposure.
4. **Eradicate and recover.** Remove the cause, confirm the fix, and verify the
   service: `GET /health` returns 200 and
   `GET /.well-known/oauth-authorization-server` returns the expected `issuer`.
   For a vault rotation, confirm `{ skipped: 0 }` on a re-run before discarding
   old key material.
5. **Notify.** On any suspected compromise of user data, notify affected users
   promptly and within applicable GDPR timelines (as a UK/EU personal-data
   controller, without undue delay and, where a notifiable personal-data breach
   has occurred, within 72 hours of becoming aware, to the relevant supervisory
   authority). Notification states plainly what happened, what data was
   involved, what the user should do (for example, rotate the affected network's
   API credentials at the network), and what has been done. Do not understate
   scope; if uncertain, say so.
6. **Disclose.** For issues reported through the security channel, coordinate
   disclosure with the reporter, credit them if they wish, and publish a note
   once users are protected. Prefer the private GitHub Security Advisory route in
   [`SECURITY.md`](../../SECURITY.md).
7. **Review.** After recovery, write a short post-incident note: timeline, root
   cause, what worked, and the smallest change that would prevent a repeat. Fold
   any procedural fix back into this runbook or the rotation runbook.

## User action, always safe to recommend

Because hosted credentials are the user's own network API keys, the strongest
user-side mitigation is always available and worth stating in any notification:
**rotate the affected network's API credentials at the network itself**, which
invalidates anything that might have been exposed regardless of what happened on
the hosted side.

## Contacts and channels

- Incident owner: the maintainer (Rob).
- Vulnerability intake: the private route in [`SECURITY.md`](../../SECURITY.md)
  (GitHub Security Advisories).
- Provider consoles that may need action during containment: Cloudflare
  (Workers, KV, account), Stripe, Resend.

## Related

- `docs/security/hosted-trust.md` — the custody model and encryption boundaries
  the scope assessment relies on.
- `docs/security/hosted-key-rotation.md` — the containment rotation procedures.
- `docs/decisions/2026-07-12-hosted-credential-custody.md` — the requirement and
  the accepted custody contract.
