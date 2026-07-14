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
 *                              first use), creates the user record if new,
 *                              and returns a minimal HTML page carrying a
 *                              freshly-issued 30-day session token. See the
 *                              file-header note in `renderSessionPage` for why
 *                              this is a copyable page rather than a
 *                              Set-Cookie.
 *   POST /auth/session/verify { token } → the primitive H4's transport will
 *                              call: validates a session token and returns
 *                              { userId, exp }.
 *   GET  /health               → liveness.
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
 *   DELETE /account                    complete account deletion
 *
 * H5 (`docs/product/hosted-mvp-workstream.md`, `src/routes/connect.ts`) adds
 * the guided connect flow — server-rendered HTML, session-gated, no client
 * framework. The session token travels in the Authorization header or a POST
 * body field, never in a URL (RFC 6750 §2.3; see the connect.ts file header),
 * so in-flow navigation is POST forms, and each page also has a
 * header-authenticated GET variant:
 *   GET|POST /connect                    list the four networks + status
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
import { publicBaseUrl } from './env.js';
import { corsHeaders, html, json, nowSeconds } from './http.js';
import {
  emailLookupKey,
  generateLinkToken,
  hashLinkToken,
  ipRateLimitHash,
  isValidEmail,
  normaliseEmail,
} from './identity.js';
import { handleDeleteAccount } from './routes/account.js';
import {
  handleConnectForm,
  handleConnectList,
  handleConnectRetest,
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

const RESEND_API_BASE = 'https://api.resend.com';
const SIGN_IN_FROM_ADDRESS = 'affiliate-mcp <sign-in@agenticaffiliate.ai>';

const LINK_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes, per the workstream brief.
const SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days.

// Basic abuse limits on /auth/request-link. These are a cheap KV-counter
// backstop against email-bombing a victim address or burning Resend quota,
// NOT the product's real rate-limiting story: H4's transport-level per-user
// limits supersede these. Per-address is deliberately tight (a human retries
// a sign-in link a handful of times); per-IP is looser because NAT puts many
// legitimate users behind one address.
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_PER_EMAIL = 5;
const RATE_LIMIT_MAX_PER_IP = 20;

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

interface PendingLinkRecord {
  emailHash: string;
  expiresAt: number;
}

// ── small helpers ────────────────────────────────────────────────────────
// json, html, corsHeaders, nowSeconds moved to ./http.js — shared with the
// H3 vault/account routes so every route builds responses the same way.

const userKey = (id: string) => `user:${id}`;
const pendingLinkKey = (tokenHash: string) => `pending-link:${tokenHash}`;

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
// Once the email is a validly-shaped address, every branch below returns 200
// with the same body, whether the address belongs to an existing user, a
// brand-new one, or nobody at all, whether the abuse limit has been hit, and
// regardless of whether the Resend send itself succeeds — a differing status
// on any of those branches would let a caller distinguish account state or
// probe the limiter, which is exactly the oracle this endpoint must not
// offer. Upstream failures are only observable server-side, via the status
// code (never the email address) on stderr. The one non-neutral non-400
// response is a 500 for a missing/invalid PUBLIC_BASE_URL: a configuration
// error is identical for every caller and every address, so it carries no
// enumeration signal either.
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

  // The emailed link's origin comes from configuration, never from the
  // request's own URL/Host — see the PUBLIC_BASE_URL note in env.ts.
  let linkOrigin: string;
  try {
    linkOrigin = publicBaseUrl(env);
  } catch (err) {
    console.error(`[auth] configuration error: ${(err as Error).message}`);
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500 }, cors);
  }

  const emailHash = await emailLookupKey(email, env);
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = await ipRateLimitHash(clientIp);
  const emailAllowed = await bumpRateLimit(env, `rl:${emailHash}`, RATE_LIMIT_MAX_PER_EMAIL);
  const ipAllowed = await bumpRateLimit(env, `rl:ip:${ipHash}`, RATE_LIMIT_MAX_PER_IP);
  if (!emailAllowed || !ipAllowed) {
    // Over-limit gets the IDENTICAL neutral response — the send is skipped,
    // but the caller learns nothing (not even that a limit exists).
    return json({ ok: true }, { status: 200 }, cors);
  }

  const rawToken = generateLinkToken();
  const tokenHash = await hashLinkToken(rawToken);
  const expiresAt = nowSeconds() + LINK_TOKEN_TTL_SECONDS;
  const pending: PendingLinkRecord = { emailHash, expiresAt };
  await env.HOSTED_USERS.put(pendingLinkKey(tokenHash), JSON.stringify(pending), {
    expirationTtl: LINK_TOKEN_TTL_SECONDS,
  });

  const callbackUrl = `${linkOrigin}/auth/callback?token=${rawToken}`;
  try {
    const res = await sendSignInEmail(env, email, callbackUrl);
    if (!res.ok) {
      // Status only — never the address, never the response body (which
      // could itself echo the address back).
      console.error(`[auth] resend send failed status=${res.status}`);
    }
  } catch (err) {
    console.error(`[auth] resend send error: ${(err as Error).message}`);
  }

  return json({ ok: true }, { status: 200 }, cors);
}

/**
 * Increment-and-check a KV rate-limit counter. Returns true when the request
 * is within `max` for the current window; false (without incrementing
 * further) once the limit is reached. KV get/put is not atomic, so
 * concurrent requests can slightly overshoot the cap, and each increment
 * refreshes the window TTL, making this a rolling-ish window rather than a
 * precise one — both acceptable for a cheap abuse backstop that H4's
 * transport-level limits will supersede.
 */
async function bumpRateLimit(env: Env, key: string, max: number): Promise<boolean> {
  const raw = await env.HOSTED_USERS.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= max) return false;
  await env.HOSTED_USERS.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

async function sendSignInEmail(env: Env, email: string, callbackUrl: string): Promise<Response> {
  return fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: SIGN_IN_FROM_ADDRESS,
      to: email,
      subject: 'Sign in to affiliate-mcp',
      text: `Sign in to affiliate-mcp: ${callbackUrl}\n\nThis link expires in 15 minutes and works once. If you did not request it, ignore this email.`,
      html: `<p>Sign in to affiliate-mcp:</p><p><a href="${callbackUrl}">${callbackUrl}</a></p><p>This link expires in 15 minutes and works once. If you did not request it, ignore this email.</p>`,
    }),
  });
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
  const iss = nowSeconds();
  const exp = iss + SESSION_TOKEN_TTL_SECONDS;
  const token = await signSession(buildSessionPayload({ sub: userId, iss, exp }), env.SESSION_SIGNING_KEY);

  return renderSessionPage(token, exp);
}

/**
 * Delivery choice: a copyable HTML page, not a `Set-Cookie`. Documented here
 * because the workstream asked for whichever is simpler and testable:
 *
 * - The session token is a bearer credential for H4's remote MCP transport
 *   (an MCP client, not this browser tab, presents it on every call), so a
 *   value the user can copy into that client is directly useful; a cookie
 *   scoped to this Worker's origin would not reach a non-browser MCP client
 *   at all and would need a second "now copy this" step regardless.
 * - It sidesteps `Set-Cookie` attribute decisions (Domain, Secure, SameSite,
 *   partitioning) that matter a great deal for a real deploy but add
 *   surface-area risk with no benefit here, since nothing about this flow
 *   relies on the browser automatically re-presenting a cookie.
 * - It is trivial to unit-test: assert the response body contains the token,
 *   with no cookie-jar/attribute parsing involved.
 */
function renderSessionPage(token: string, exp: number): Response {
  const expIso = new Date(exp * 1000).toISOString();
  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>signed in</title>
<style>
  body { font-family:'JetBrains Mono',ui-monospace,Menlo,monospace; background:#fff; color:#0a0a0a;
         margin:0; padding:40px 20px; display:flex; justify-content:center; }
  .card { width:100%; max-width:640px; border:2px solid #0a0a0a; padding:28px; box-shadow:6px 6px 0 #0a0a0a; }
  h1 { font-size:22px; font-weight:700; margin:0 0 4px; text-transform:lowercase; }
  p { font-size:14px; line-height:1.55; }
  .muted { color:#555; font-size:12px; }
  textarea { width:100%; box-sizing:border-box; font-family:inherit; font-size:12px; padding:10px;
             border:1px solid #0a0a0a; margin:12px 0; }
  button { font-family:inherit; font-size:13px; padding:8px 14px; border:2px solid #0a0a0a; background:#fff;
           cursor:pointer; }
</style></head>
<body><div class="card">
  <h1>you're signed in</h1>
  <p>Copy this session token into your MCP client's connection settings.</p>
  <textarea id="hosted-session-token" readonly rows="4">${token}</textarea>
  <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('hosted-session-token').value)">copy token</button>
  <p class="muted">Expires ${expIso}. Do not share this token; anyone holding it can act as your account.</p>
</div></body></html>`);
}

function renderErrorPage(message: string): Response {
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sign-in error</title></head>
<body><p>${message}</p></body></html>`,
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
  return json({ userId: payload.sub, exp: payload.exp, scope: sessionScope(payload) }, { status: 200 }, cors);
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/auth/request-link' && request.method === 'POST') {
      return handleRequestLink(request, env, cors);
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      return handleCallback(request, env);
    }
    if (url.pathname === '/auth/session/verify' && request.method === 'POST') {
      return handleSessionVerify(request, env, cors);
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
    if (url.pathname === '/account' && request.method === 'DELETE') {
      return handleDeleteAccount(request, env, cors);
    }

    // ── H5: guided connect flow (src/routes/connect.ts) ────────────────────
    // Server-rendered HTML, session-gated via a browser-flavoured check: the
    // session token arrives in the Authorization header or a POST body field,
    // NEVER a URL — see the file-header comment in src/routes/connect.ts for
    // the RFC 6750 §2.3 reasoning, and why in-flow navigation is POST forms.
    // Route order matters: the `/form` and `/retest` suffixes must be matched
    // before the bare `/:network` routes.
    if (url.pathname === '/connect' && (request.method === 'GET' || request.method === 'POST')) {
      return handleConnectList(request, env);
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
