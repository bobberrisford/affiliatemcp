/**
 * affiliate-mcp hosted Worker (workstream slices H2, H3, H5, and H6:
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * H2 (auth) holds NO affiliate credentials and NO affiliate data in
 * `HOSTED_USERS` — a user id and an email-hash lookup, nothing else. H3 (the
 * encrypted credential vault, `src/vault.ts`) adds a SEPARATE KV namespace,
 * `HOSTED_VAULT`, that does hold per-user encrypted network credentials,
 * gated on the open master-key question this slice's PR leaves for Rob (see
 * `hosted/README.md` "Vault threat model"). Every H3 route in this file
 * requires the same session token H2 issues; none of the H2 auth routes
 * below touch `HOSTED_VAULT`. H4 (remote MCP transport) is the first
 * consumer of both: the session token, and `getCredentials` from
 * `src/vault.ts` to run an adapter call under the caller's own identity.
 *
 * Endpoints:
 *   POST /auth/request-link   { email } → creates a single-use, 15-minute
 *                              sign-in token, stores only its hash in KV, and
 *                              emails the magic link (built on the configured
 *                              PUBLIC_BASE_URL, never the request's own Host)
 *                              via Resend's transactional send API. Always 200
 *                              with a neutral body for any validly-shaped
 *                              email, whether or not an account exists and
 *                              whether or not the cheap per-address/per-IP
 *                              abuse limit was hit — see `handleRequestLink`
 *                              for the exact boundary between this and a 400
 *                              (shape errors carry no account-existence
 *                              signal, so they stay a 400, matching the
 *                              waitlist Worker's precedent).
 *   GET  /auth/callback       ?token=… → verifies and consumes the sign-in
 *                              token (single-use: its KV record is deleted on
 *                              first use), creates the user record if new, and
 *                              then EITHER resumes an OAuth authorization (if
 *                              the pending-link record carries an
 *                              `authRequestId` — renders the consent page,
 *                              `renderConsentPage`, `src/routes/oauth.ts`) OR,
 *                              for a plain sign-in, sets an HttpOnly session
 *                              cookie (`setSessionCookieHeader`, `src/http.ts`)
 *                              and 303-redirects to the browser connect/manage
 *                              dashboard (`/connect`). No token is shown for the
 *                              user to copy: MCP clients authenticate via OAuth
 *                              (`Add custom connector`), and the dashboard reads
 *                              its session from the cookie
 *                              (`docs/decisions/2026-07-15-hosted-connector-oauth.md`,
 *                              slice 3).
 *   POST /auth/session/verify { token } → the primitive H4's transport calls:
 *                              validates a session token and returns
 *                              { userId, exp, iss, scope }. `iss` lets the
 *                              transport compute token lifetime (exp - iss) and
 *                              tell a short-lived OAuth access token apart from
 *                              a long-lived pasted bearer during the staged
 *                              migration.
 *   GET  /health               → liveness.
 *
 * OAuth 2.1 authorization server (slice 1,
 * `docs/decisions/2026-07-15-hosted-connector-oauth.md`, `src/routes/oauth.ts`)
 * — client-to-transport authentication per the MCP authorization framework,
 * replacing the pasted bearer as the thing the connect flow hands out:
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 discovery
 *   POST /register                                RFC 7591 dynamic registration
 *   GET  /authorize                               validate + sign-in page (PKCE)
 *   POST /authorize/email                         send the magic link for it
 *   POST /authorize/consent                       approve/deny → code + redirect
 *   POST /token                                   authorization_code + refresh_token
 *
 * H3 (`docs/product/hosted-mvp-workstream.md`, `src/vault.ts`) adds the
 * encrypted credential vault and its routes (`src/routes/vault.ts`,
 * `src/routes/account.ts`), every one of them requiring the same session
 * token this file issues:
 *   POST   /vault/credentials                 store one network's credential
 *   GET    /vault/credentials                 list connected networks, never values
 *   DELETE /vault/credentials/:network        remove one network's credential
 *   GET    /vault/credentials/:network/reveal decrypt and return one network's
 *                              credential (H4 only — see the file-header
 *                              comment in `src/routes/vault.ts`)
 *   GET    /account/export             export everything held about the
 *                              caller, metadata only, never a credential value
 *   DELETE /account                    complete account deletion
 *
 * H5 (`docs/product/hosted-mvp-workstream.md`, `src/routes/connect.ts`) adds
 * the guided connect flow — server-rendered HTML, session-gated, no client
 * framework. The browser authenticates via the HttpOnly `hosted_session`
 * cookie set at the plain sign-in callback (slice 3,
 * `docs/decisions/2026-07-15-hosted-connector-oauth.md`; see the connect.ts
 * file header). In-flow navigation is same-site POST forms the cookie
 * accompanies, and each page also has a header-authenticated GET variant for
 * non-browser callers:
 *   GET|POST /connect                    list the four networks + status
 *   POST /connect/signin                 send a magic link to sign into the
 *                              dashboard (sets the cookie on the callback)
 *   POST /connect/:network/form          guided credential form (POST-nav)
 *   GET  /connect/:network               same form, Authorization header only
 *   POST /connect/:network               store, then connection-test, one network
 *   GET|POST /connect/:network/retest    re-run the connection test, no resubmit
 *
 * Also part of the connect UI, matched BEFORE the generic `/connect/:network`
 * patterns above since "billing" is not a network slug (Stripe-wiring
 * follow-up to H6; `src/routes/billing-page.ts`):
 *   GET|POST /connect/billing            current tier/status + subscribe,
 *                              upgrade, and manage buttons
 *   POST /connect/billing/checkout       browser hand-off to Stripe Checkout
 *   POST /connect/billing/portal         browser hand-off to the Stripe
 *                              Billing Portal
 *
 * H6 (`docs/product/hosted-mvp-workstream.md`, `src/billing.ts`) adds Stripe
 * subscription state (`src/routes/billing.ts`) and the scheduled digest
 * (`src/digest.ts`, driven by the `scheduled` handler below, a Cloudflare
 * Cron Trigger, not an HTTP route):
 *   POST /billing/checkout      full-session-gated, creates a Stripe
 *                              Checkout Session for the requested tier
 *   POST /billing/webhook      Stripe-signature-verified, mirrors the
 *                              subscription lifecycle into HOSTED_BILLING
 *   GET  /billing/entitlement  full-session-gated, { tier, status }, the
 *                              ONE billing route the hosted MCP transport
 *                              calls
 *   POST /billing/portal       full-session-gated, creates a Stripe Billing
 *                              Portal session for the caller's own customer
 *                              id (Stripe-wiring follow-up; the billing
 *                              page above is its browser-facing caller)
 * There are NO service-authenticated admin routes and NO all-tenant
 * credential: Rob rejected that design on 2026-07-14 (`hosted/README.md`,
 * "Digest orchestration and token scopes"). The scheduled handler
 * enumerates subscribers in-process from HOSTED_BILLING KV, mints
 * short-lived digest-scoped tokens itself (it already holds
 * SESSION_SIGNING_KEY), calls the Node compose service for the rendered
 * text, and sends via Resend Worker-side. Tier administration before the
 * live Stripe wiring is manual `wrangler kv key put` (documented in
 * `hosted/README.md`, "Manual tier administration"), not a route.
 *
 * H6 also introduces token scopes (`src/token.ts`): digest-scoped tokens
 * are accepted only by the vault list and reveal routes; every other
 * session-gated surface requires a full session
 * (`requireFullSession`, `src/routes/guard.ts`).
 *
 * Resend note: the rescinded waitlist-Resend decision
 * (`docs/decisions/2026-07-12-waitlist-email-resend.md`) was specifically
 * about marketing capture, and was rescinded only because the pre-sell gate
 * it served was dropped
 * (`docs/decisions/2026-07-13-build-hosted-without-presell.md`). That same
 * pivot record explicitly names transactional email as a reusable follow-on
 * of the waitlist Worker's pattern — "the pattern and CI job are reusable for
 * transactional email later, for example magic-link sign-in" — which is
 * exactly what this file does: a plain `fetch` to Resend's send API, the
 * Worker's own secret, no new dependency.
 */

import type { Env } from './env.js';
import { corsHeaders, json, nowSeconds, setSessionCookieHeader } from './http.js';
import { escapeHtml, renderShell } from './page-chrome.js';
import { hashLinkToken, isValidEmail, normaliseEmail } from './identity.js';
import {
  dispatchMagicLink,
  MagicLinkConfigError,
  pendingLinkKey,
  type PendingLinkRecord,
} from './auth-link.js';
import {
  handleAuthorize,
  handleAuthorizeEmail,
  handleConsent,
  handleOAuthMetadata,
  handleRegister,
  handleToken,
  isPublicOAuthApiPath,
  oauthCors,
  renderConsentPage,
} from './routes/oauth.js';
import { handleDeleteAccount, handleExportAccount } from './routes/account.js';
import {
  handleConnectForm,
  handleConnectList,
  handleConnectRetest,
  handleConnectSignin,
  handleConnectSubmit,
} from './routes/connect.js';
import {
  handleBillingPage,
  handleBillingPageCheckout,
  handleBillingPagePortal,
} from './routes/billing-page.js';
import {
  handleDeleteCredential,
  handleListCredentials,
  handlePutCredentials,
  handleRevealCredentials,
} from './routes/vault.js';
import {
  handleBillingCheckout,
  handleBillingEntitlement,
  handleBillingPortal,
  handleBillingWebhook,
} from './routes/billing.js';
import { runScheduledDigest } from './digest.js';
import { buildSessionPayload, generateUserId, sessionScope, signSession, verifySession } from './token.js';

const SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days.

interface UserRecord {
  id: string;
  createdAt: number;
  /**
   * The `email-hash:<hmacHex>` key that resolves to this user, stored on the
   * record itself so `DELETE /account` (`src/routes/account.ts`) can remove
   * that reverse-lookup entry too. Without this, deletion would strand the
   * `email-hash:` entry pointing at a userId that no longer exists — H3's
   * "complete deletion" requirement is what surfaced this gap; H2 had no
   * deletion path to expose it.
   */
  emailHash: string;
}

// ── small helpers ────────────────────────────────────────────────────────
// json, html, corsHeaders, nowSeconds moved to ./http.js — shared with the
// H3 vault/account routes so every route builds responses the same way. The
// magic-link SEND logic (rate limits, Resend call, neutrality, pending-link
// record) moved to ./auth-link.js so the OAuth authorization flow
// (./routes/oauth.js) reuses the identical send; PendingLinkRecord and
// pendingLinkKey are imported from there.

const userKey = (id: string) => `user:${id}`;

async function getUserByEmailHash(env: Env, emailHash: string): Promise<string | null> {
  return env.HOSTED_USERS.get(emailHash);
}

async function getOrCreateUser(env: Env, emailHash: string): Promise<string> {
  const existing = await getUserByEmailHash(env, emailHash);
  if (existing) return existing;
  const id = generateUserId();
  const record: UserRecord = { id, createdAt: nowSeconds(), emailHash };
  await env.HOSTED_USERS.put(userKey(id), JSON.stringify(record));
  await env.HOSTED_USERS.put(emailHash, id);
  return id;
}

// ── POST /auth/request-link ─────────────────────────────────────────────
//
// Neutrality boundary: a malformed request (bad JSON, missing/malformed
// email) gets a 400 — that response depends only on what the caller typed,
// never on whether an account exists, so it is not an enumeration channel.
// Once the email is a validly-shaped address, the response is the identical
// neutral 200 whether the address belongs to an existing user, a brand-new
// one, or nobody at all, whether the abuse limit was hit, and regardless of
// whether the Resend send succeeded — the whole neutral send lives in
// `dispatchMagicLink` (`./auth-link.js`), shared with the OAuth flow. The one
// non-neutral non-400 response is a 500 for a missing/invalid PUBLIC_BASE_URL
// (`MagicLinkConfigError`): a configuration error is identical for every
// caller and every address, so it carries no enumeration signal either.
async function handleRequestLink(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 }, cors);
  }
  if (!isValidEmail(body.email)) {
    return json({ ok: false, error: 'invalid_email' }, { status: 400 }, cors);
  }
  const email = normaliseEmail(body.email);

  try {
    await dispatchMagicLink(request, env, email);
  } catch (err) {
    if (err instanceof MagicLinkConfigError) {
      console.error(`[auth] configuration error: ${err.message}`);
      return json({ ok: false, error: 'server_misconfigured' }, { status: 500 }, cors);
    }
    throw err;
  }

  return json({ ok: true }, { status: 200 }, cors);
}

// ── GET /auth/callback ───────────────────────────────────────────────────
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const rawToken = new URL(request.url).searchParams.get('token');
  if (!rawToken) return renderErrorPage('This sign-in link is missing its token.');

  const tokenHash = await hashLinkToken(rawToken);
  const key = pendingLinkKey(tokenHash);
  const raw = await env.HOSTED_USERS.get(key);
  if (!raw) return renderErrorPage('This sign-in link is invalid or has already been used.');

  // Consume immediately (single-use), before any further work. KV's TTL is
  // the primary expiry mechanism, but the explicit `expiresAt` check below is
  // a defensive backstop against TTL propagation delay.
  await env.HOSTED_USERS.delete(key);

  const pending = JSON.parse(raw) as PendingLinkRecord;
  if (pending.expiresAt <= nowSeconds()) {
    return renderErrorPage('This sign-in link has expired. Request a new one.');
  }

  const userId = await getOrCreateUser(env, pending.emailHash);

  // If this sign-in was started to complete an OAuth authorization
  // (`./routes/oauth.js`), resume into the consent page instead of handing the
  // user a token to copy: the OAuth client, not the user, ends up holding a
  // token. `renderConsentPage` handles a request that expired between the
  // email send and the click. This is the path the decision makes primary
  // (`docs/decisions/2026-07-15-hosted-connector-oauth.md`).
  if (pending.authRequestId) {
    return renderConsentPage(env, pending.authRequestId, userId);
  }

  // Plain sign-in (no OAuth authorization in flight): establish the BROWSER
  // dashboard session as an HttpOnly cookie and redirect to the dashboard.
  // Since the accepted decision
  // (`docs/decisions/2026-07-15-hosted-connector-oauth.md`), no token is ever
  // shown for the user to copy: MCP clients connect via OAuth ("Add custom
  // connector"), and the connect/manage dashboard (H5, `src/routes/connect.ts`)
  // reads the session from this cookie. The token therefore never appears in
  // the response body — only in a `Set-Cookie` the browser stores and the page
  // scripts cannot read.
  const iss = nowSeconds();
  const exp = iss + SESSION_TOKEN_TTL_SECONDS;
  const token = await signSession(buildSessionPayload({ sub: userId, iss, exp }), env.SESSION_SIGNING_KEY);

  return new Response(null, {
    status: 303,
    headers: {
      location: '/connect',
      'set-cookie': setSessionCookieHeader(token, SESSION_TOKEN_TTL_SECONDS),
      'cache-control': 'no-store',
    },
  });
}

function renderErrorPage(message: string): Response {
  return renderShell(
    'sign-in error',
    `<h1>sign-in error</h1>
    <p>${escapeHtml(message)}</p>
    <p><a class="btn p" href="https://agenticaffiliate.ai/hosted.html">get a new sign-in link</a></p>`,
    400,
  );
}

// ── POST /auth/session/verify ────────────────────────────────────────────
async function handleSessionVerify(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return json({ error: 'invalid_request' }, { status: 400 }, cors);
  }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    return json({ error: 'invalid_request' }, { status: 400 }, cors);
  }

  const payload = await verifySession(body.token, env.SESSION_SIGNING_KEY);
  if (!payload) return json({ error: 'invalid_token' }, { status: 401 }, cors);
  if (payload.exp <= nowSeconds()) return json({ error: 'expired_token' }, { status: 401 }, cors);

  // `scope` (H6, `src/token.ts`): "full" for every sign-in session, "digest"
  // for the short-lived tokens the scheduled digest mints. The hosted MCP
  // transport reads this to REFUSE digest-scoped tokens
  // (`src/hosted-transport/session-auth.ts`, root workspace) — a digest
  // token authorises two vault reads, not interactive tool calls.
  // `iss` (issued-at) is surfaced alongside `exp` so the transport can compute
  // a token's lifetime (`exp - iss`) and enforce a maximum: a short-lived OAuth
  // access token and a long-lived pasted bearer are the same wire format and
  // differ only in lifetime, so lifetime is what tells them apart during the
  // staged migration (`src/hosted-transport/session-auth.ts`,
  // `docs/decisions/2026-07-15-hosted-connector-oauth.md`). Additive and
  // backward-compatible: older transport builds ignore the extra field.
  return json(
    { userId: payload.sub, exp: payload.exp, iss: payload.iss, scope: sessionScope(payload) },
    { status: 200 },
    cors,
  );
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env);

    if (request.method === 'OPTIONS') {
      // The client-facing OAuth API endpoints (metadata, register, token) are
      // reachable cross-origin by arbitrary MCP clients and carry no ambient
      // credentials, so they answer preflight with a wildcard origin
      // (`oauthCors`); everything else uses the site-origin-reflecting `cors`.
      const preflight = isPublicOAuthApiPath(url.pathname) ? oauthCors() : cors;
      return new Response(null, { status: 204, headers: preflight });
    }

    if (url.pathname === '/auth/request-link' && request.method === 'POST') {
      return handleRequestLink(request, env, cors);
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      return handleCallback(request, env);
    }
    if (url.pathname === '/auth/session/verify' && request.method === 'POST') {
      return handleSessionVerify(request, env, cors);
    }

    // ── OAuth 2.1 authorization server (slice 1, src/routes/oauth.ts) ───────
    // Client identity auth per the MCP authorization framework
    // (`docs/decisions/2026-07-15-hosted-connector-oauth.md`). Distinct from
    // the H5 network-credential collection above and from H5's "OAuth where
    // supported" (a network's OAuth, e.g. Rakuten) — these authenticate the
    // MCP CLIENT to this transport, nothing else.
    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return handleOAuthMetadata(env);
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }
    if (url.pathname === '/authorize' && request.method === 'GET') {
      return handleAuthorize(request, env);
    }
    if (url.pathname === '/authorize/email' && request.method === 'POST') {
      return handleAuthorizeEmail(request, env);
    }
    if (url.pathname === '/authorize/consent' && request.method === 'POST') {
      return handleConsent(request, env);
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      return handleToken(request, env);
    }

    // ── H3: encrypted credential vault (src/vault.ts, src/routes/*) ────────
    if (url.pathname === '/vault/credentials' && request.method === 'POST') {
      return handlePutCredentials(request, env, cors);
    }
    if (url.pathname === '/vault/credentials' && request.method === 'GET') {
      return handleListCredentials(request, env, cors);
    }
    const vaultCredentialMatch = url.pathname.match(/^\/vault\/credentials\/([^/]+)$/);
    if (vaultCredentialMatch && request.method === 'DELETE') {
      return handleDeleteCredential(request, env, decodeURIComponent(vaultCredentialMatch[1] as string), cors);
    }
    const vaultRevealMatch = url.pathname.match(/^\/vault\/credentials\/([^/]+)\/reveal$/);
    if (vaultRevealMatch && request.method === 'GET') {
      return handleRevealCredentials(request, env, decodeURIComponent(vaultRevealMatch[1] as string), cors);
    }
    if (url.pathname === '/account/export' && request.method === 'GET') {
      return handleExportAccount(request, env, cors);
    }
    if (url.pathname === '/account' && request.method === 'DELETE') {
      return handleDeleteAccount(request, env, cors);
    }

    // ── H5: guided connect flow (src/routes/connect.ts) ────────────────────
    // Server-rendered HTML, session-gated via a browser-flavoured check: the
    // session arrives in the HttpOnly `hosted_session` cookie (or, for
    // non-browser callers, the Authorization header), NEVER a URL — see the
    // file-header comment in src/routes/connect.ts for the cookie/CSRF model,
    // and why in-flow navigation is same-site POST forms.
    // Route order matters: `/signin`, `/form`, and `/retest` must be matched
    // before the bare `/:network` routes.
    if (url.pathname === '/connect' && (request.method === 'GET' || request.method === 'POST')) {
      return handleConnectList(request, env);
    }
    // Dashboard email sign-in: sends the same magic link as the plain
    // /auth/request-link flow (no authRequestId), so the returning cookie
    // callback lands the user back on the dashboard. Matched BEFORE the
    // generic /connect/:network POST so "signin" is not treated as a network
    // slug, exactly like the /connect/billing special-casing below.
    if (url.pathname === '/connect/signin' && request.method === 'POST') {
      return handleConnectSignin(request, env);
    }
    // Billing/account page: an exact-path match, checked BEFORE the generic
    // /connect/:network patterns below, since "billing" is not one of the
    // four hosted-eligible network slugs (src/networks.ts) and would
    // otherwise fall through to those handlers' "network not found" page.
    if (url.pathname === '/connect/billing' && (request.method === 'GET' || request.method === 'POST')) {
      return handleBillingPage(request, env);
    }
    if (url.pathname === '/connect/billing/checkout' && request.method === 'POST') {
      return handleBillingPageCheckout(request, env);
    }
    if (url.pathname === '/connect/billing/portal' && request.method === 'POST') {
      return handleBillingPagePortal(request, env);
    }
    const connectFormMatch = url.pathname.match(/^\/connect\/([^/]+)\/form$/);
    if (connectFormMatch && request.method === 'POST') {
      return handleConnectForm(request, env, decodeURIComponent(connectFormMatch[1] as string));
    }
    const connectRetestMatch = url.pathname.match(/^\/connect\/([^/]+)\/retest$/);
    if (connectRetestMatch && (request.method === 'GET' || request.method === 'POST')) {
      return handleConnectRetest(request, env, decodeURIComponent(connectRetestMatch[1] as string));
    }
    const connectNetworkMatch = url.pathname.match(/^\/connect\/([^/]+)$/);
    if (connectNetworkMatch && request.method === 'GET') {
      return handleConnectForm(request, env, decodeURIComponent(connectNetworkMatch[1] as string));
    }
    if (connectNetworkMatch && request.method === 'POST') {
      return handleConnectSubmit(request, env, decodeURIComponent(connectNetworkMatch[1] as string));
    }

    // ── H6: billing (src/billing.ts, src/routes/billing.ts) ────────────────
    if (url.pathname === '/billing/checkout' && request.method === 'POST') {
      return handleBillingCheckout(request, env, cors);
    }
    if (url.pathname === '/billing/webhook' && request.method === 'POST') {
      return handleBillingWebhook(request, env, cors);
    }
    if (url.pathname === '/billing/entitlement' && request.method === 'GET') {
      return handleBillingEntitlement(request, env, cors);
    }
    if (url.pathname === '/billing/portal' && request.method === 'POST') {
      return handleBillingPortal(request, env, cors);
    }

    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      return new Response('affiliate-mcp hosted', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },

  /**
   * H6: the scheduled digest (`src/digest.ts`), driven by the Cron Trigger
   * in `wrangler.toml` (`[triggers]`). The whole orchestration runs
   * in-process — roster from KV, per-user digest-scoped token minting,
   * compose-service call, Resend send — so no external credential can
   * enumerate tenants or mint sessions. No-ops with one log line while
   * `DIGEST_SERVICE_URL` is unset.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduledDigest(env);
  },
};
