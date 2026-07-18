/**
 * OAuth 2.1 authorization-code + PKCE endpoints for the hosted connector
 * (decision `docs/decisions/2026-07-15-hosted-connector-oauth.md`, slice 1).
 * The storage-and-crypto layer is `src/oauth.ts`; this file is the routes.
 *
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 discovery document
 *   POST /register                                RFC 7591 dynamic client registration
 *   GET  /authorize                               validate + render the sign-in page
 *   POST /authorize/email                         send the magic link for this request
 *   POST /authorize/consent                       approve/deny → issue code, redirect
 *   POST /token                                   authorization_code + refresh_token grants
 *
 * The flow, end to end:
 *
 *   1. The MCP client discovers these endpoints from the metadata document,
 *      (dynamically) registers to get a `client_id`, then opens the user's
 *      browser at `GET /authorize?...` with a PKCE `code_challenge`.
 *   2. `/authorize` validates the request, stores it (`oauth:req:<id>`), and
 *      renders a sign-in page: an email field. Submitting it
 *      (`POST /authorize/email`) sends the SAME magic link the ordinary
 *      sign-in uses (`dispatchMagicLink`, `src/auth-link.ts`), carrying the
 *      request id in the pending-link record — never in the emailed URL.
 *   3. The user clicks the emailed link. `GET /auth/callback` (`src/index.ts`)
 *      consumes it and establishes identity exactly as before. Because the
 *      pending record carries an `authRequestId`, instead of rendering a page at
 *      that token-bearing URL it stashes a single-use consent handoff
 *      (`oauth:consent:`, `src/oauth.ts`), sets an opaque cookie naming it, and
 *      303-redirects to the token-free `GET /authorize/consent`. That page
 *      (`handleConsentPage` → `renderConsentPage` below) reads the cookie,
 *      consumes the handoff, and renders the CONSENT page. Consent identity is
 *      proved by a short-lived full session token embedded in the form as a
 *      hidden field (the same header-or-hidden-field, never-a-URL discipline the
 *      H5 connect flow uses, `src/routes/connect.ts`); nothing that identifies
 *      the request or the user ever rides in a URL.
 *   4. Approving (`POST /authorize/consent`) mints a single-use authorization
 *      code bound to the PKCE challenge and 302-redirects the browser back to
 *      the client's `redirect_uri` with `code` and `state`.
 *   5. The client exchanges the code at `POST /token` with its `code_verifier`
 *      (PKCE S256), receiving a short-lived access token and a refresh token.
 *      The client stores both; the USER pastes nothing.
 *
 * Access token = a short-lived, full-scope `amcps_` hosted session token
 * (`src/token.ts`), verified by the existing `POST /auth/session/verify`, so
 * the transport keeps working unchanged during the staged migration. Refresh
 * token = an opaque, rotated, server-side credential. See the `src/oauth.ts`
 * file header for the full rationale.
 */

import type { Env } from '../env.js';
import { publicBaseUrl } from '../env.js';
import { clearConsentCookieHeader, consentCookie, json, nowSeconds } from '../http.js';
import { escapeHtml, renderShell } from '../page-chrome.js';
import { ipRateLimitHash, isValidEmail, normaliseEmail } from '../identity.js';
import {
  buildSessionPayload,
  resolveValidSession,
  sessionScope,
  signSession,
} from '../token.js';
import { bumpRateLimit, dispatchMagicLink, MagicLinkConfigError } from '../auth-link.js';
import {
  authorizationServerMetadata,
  consumeAuthCode,
  consumeConsentHandoff,
  consumeRefreshToken,
  deletePendingRequest,
  getClient,
  getPendingRequest,
  isAcceptableRedirectUri,
  isRegisteredRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  issueAuthCode,
  issueRefreshToken,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_CODE_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  OAUTH_REQUEST_TTL_SECONDS,
  OAUTH_SCOPE,
  putPendingRequest,
  registerClient,
  verifyPkceS256,
  type AuthCodeRecord,
  type PendingAuthRequest,
  type RefreshRecord,
} from '../oauth.js';

// ── Public CORS for the client-facing OAuth endpoints ──────────────────────
// The metadata, registration, and token endpoints are called by arbitrary MCP
// clients (a desktop app, a web connector on another origin), not only this
// product's own front-end, and they carry NO ambient credentials — no cookie,
// no Authorization for the metadata/register/token calls beyond the bearer/PKCE
// material in the request itself — so a wildcard origin is safe and is what
// lets a browser-based MCP client reach them. Distinct from `corsHeaders`
// (`src/http.js`), which reflects only the configured site origin for the
// cookie-adjacent auth/vault routes.
export function oauthCors(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
}

/** The client-facing OAuth API paths that use `oauthCors`, so the router's
 * OPTIONS preflight can answer them with the wildcard origin. The browser
 * ceremony pages (`/authorize`, `/authorize/*`) are same-origin navigations
 * and are deliberately NOT in this set. */
export function isPublicOAuthApiPath(pathname: string): boolean {
  return (
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname === '/register' ||
    pathname === '/token'
  );
}

// ── Page chrome ──────────────────────────────────────────────────────────────

/** An HTML page in the OAuth ceremony. Renders through the shared design-system
 * shell (`../page-chrome.ts`), the same look as the connect dashboard and the
 * marketing site. Like every hosted page it is `no-store` (from `html()`) and
 * `same-origin` referrer policy (set by `renderShell`): cross-origin
 * navigations (including the eventual redirect to the client's `redirect_uri`)
 * carry no `Referer`. The consent token lives in a hidden field, i.e. the POST
 * body, which `Referer` never carries, so the policy choice does not affect it;
 * `same-origin` is used flow-wide so the connect flow's own same-origin CSRF
 * check keeps working (see `renderShell`). */
function oauthPage(title: string, bodyHtml: string, status = 200): Response {
  return renderShell(title, bodyHtml, status);
}

function errorPage(message: string, status = 400): Response {
  return oauthPage('authorisation error', `<h1>authorisation error</h1><p>${escapeHtml(message)}</p>`, status);
}

// ── Token minting ──────────────────────────────────────────────────────────

/** Mint a full-scope `amcps_` session token for `userId` valid for `ttl`
 * seconds. Used both for the short-lived consent-identity token and for the
 * OAuth access token — the two only differ in lifetime. Never mints a
 * digest-scoped token: OAuth issues full sessions only. */
async function mintFullSession(
  env: Env,
  userId: string,
  ttlSeconds: number,
): Promise<{ token: string; exp: number }> {
  const iss = nowSeconds();
  const exp = iss + ttlSeconds;
  const token = await signSession(buildSessionPayload({ sub: userId, iss, exp }), env.SESSION_SIGNING_KEY);
  return { token, exp };
}

// ── Redirect builders ──────────────────────────────────────────────────────

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return redirectResponse(url.toString());
}

// ── GET /.well-known/oauth-authorization-server ────────────────────────────

export function handleOAuthMetadata(env: Env): Response {
  let issuer: string;
  try {
    issuer = publicBaseUrl(env);
  } catch {
    // Same posture as the sign-in routes: a misconfigured base URL is a 500
    // identical for every caller, carrying no enumeration signal.
    return json({ error: 'server_misconfigured' }, { status: 500 }, oauthCors());
  }
  return json(authorizationServerMetadata(issuer), { status: 200 }, oauthCors());
}

// ── POST /register (RFC 7591 dynamic client registration) ──────────────────

/** IP cap on the unauthenticated `/register` endpoint: it writes a permanent
 * `oauth:client:` KV record per call, so, unlike the magic-link send, it is a
 * standing-storage write with no natural expiry. A per-IP hourly ceiling is a
 * cheap backstop against a loop that inflates KV with junk clients; it is not
 * a correctness gate (a real client registers once). Keyed by the same one-way
 * IP hash the request-link limiter uses, so no raw IP is stored. */
const REGISTER_MAX_PER_IP = 20;

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = await ipRateLimitHash(clientIp);
  if (!(await bumpRateLimit(env, `rl:reg:${ipHash}`, REGISTER_MAX_PER_IP))) {
    return json(
      { error: 'temporarily_unavailable', error_description: 'Too many registrations from this address. Try again later.' },
      { status: 429 },
      oauthCors(),
    );
  }

  let body: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON.' }, { status: 400 }, oauthCors());
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return json(
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array.' },
      { status: 400 },
      oauthCors(),
    );
  }
  const cleaned: string[] = [];
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAcceptableRedirectUri(uri)) {
      return json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'Each redirect_uri must be an absolute https URL or an http loopback URL.',
        },
        { status: 400 },
        oauthCors(),
      );
    }
    cleaned.push(uri);
  }

  // Slice 1 serves public clients only. A client asking for anything other
  // than `none` is refused rather than silently downgraded, so its
  // expectations and this server's behaviour never diverge.
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Only public clients (token_endpoint_auth_method "none") are supported.',
      },
      { status: 400 },
      oauthCors(),
    );
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name : undefined;
  const record = await registerClient(env.HOSTED_USERS, cleaned, clientName, nowSeconds());

  return json(
    {
      client_id: record.clientId,
      client_id_issued_at: record.createdAt,
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(record.clientName ? { client_name: record.clientName } : {}),
    },
    { status: 201 },
    oauthCors(),
  );
}

// ── GET /authorize ─────────────────────────────────────────────────────────

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const scope = params.get('scope') ?? OAUTH_SCOPE;
  const state = params.get('state') ?? undefined;
  const resource = params.get('resource') ?? undefined;

  // client_id and redirect_uri must be validated BEFORE any redirect: an
  // unknown client or an unregistered redirect_uri must NOT be redirected to
  // (that would make this endpoint an open redirector). These render an
  // on-Worker error page instead.
  if (!clientId) return errorPage('Missing client_id.');
  const client = await getClient(env.HOSTED_USERS, clientId);
  if (!client) return errorPage('Unknown client_id. Register the client first.');
  if (!redirectUri) return errorPage('Missing redirect_uri.');
  if (!isRegisteredRedirectUri(client, redirectUri)) {
    return errorPage('redirect_uri does not match a registered redirect URI for this client.');
  }

  // From here the redirect_uri is trusted, so protocol errors go back to the
  // client as an OAuth error redirect (RFC 6749 §4.1.2.1) rather than a page.
  if (responseType !== 'code') {
    return redirectWithError(redirectUri, 'unsupported_response_type', 'Only response_type=code is supported.', state);
  }
  if (codeChallengeMethod !== 'S256') {
    return redirectWithError(
      redirectUri,
      'invalid_request',
      'code_challenge_method must be S256 (PKCE is mandatory).',
      state,
    );
  }
  if (!isValidCodeChallenge(codeChallenge)) {
    return redirectWithError(redirectUri, 'invalid_request', 'Missing or malformed code_challenge.', state);
  }

  const pending: PendingAuthRequest = {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: 'S256',
    scope,
    ...(state ? { state } : {}),
    ...(resource ? { resource } : {}),
    expiresAt: nowSeconds() + OAUTH_REQUEST_TTL_SECONDS,
  };
  const reqId = await putPendingRequest(env.HOSTED_USERS, pending);

  return renderSignInPage(reqId, client.clientName);
}

function renderSignInPage(reqId: string, clientName: string | undefined, errorMessage?: string): Response {
  const who = clientName ? escapeHtml(clientName) : 'An application';
  const errorHtml = errorMessage ? `<div class="note">${escapeHtml(errorMessage)}</div>` : '';
  return oauthPage(
    'authorise access',
    `
    <h1>authorise access</h1>
    <p>${who} wants to connect to your affiliate-mcp hosted account.</p>
    ${errorHtml}
    <p>Sign in with your email to continue. We will send you a one-time link;
    once you follow it you can approve the connection. There is no token to copy
    or paste: your client receives access automatically.</p>
    <form method="post" action="/authorize/email">
      <input type="hidden" name="auth_req" value="${escapeHtml(reqId)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required>
      <button class="btn p" type="submit">send sign-in link</button>
    </form>
    <p class="muted">Signing in creates a hosted account if you do not already
    have one. The link expires in 15 minutes and works once.</p>
  `,
  );
}

// ── POST /authorize/email ────────────────────────────────────────────────────

export async function handleAuthorizeEmail(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage('Could not read the submitted form.');
  }
  const reqId = form.get('auth_req');
  const emailRaw = form.get('email');
  if (typeof reqId !== 'string' || reqId.length === 0) {
    return errorPage('Missing authorisation request. Restart the connection from your client.');
  }

  const pending = await getPendingRequest(env.HOSTED_USERS, reqId);
  if (!pending || pending.expiresAt <= nowSeconds()) {
    return errorPage('This authorisation request has expired. Restart the connection from your client.');
  }

  const client = await getClient(env.HOSTED_USERS, pending.clientId);
  if (!isValidEmail(emailRaw)) {
    return renderSignInPage(reqId, client?.clientName, 'Enter a valid email address.');
  }
  const email = normaliseEmail(emailRaw);

  try {
    await dispatchMagicLink(request, env, email, reqId);
  } catch (err) {
    if (err instanceof MagicLinkConfigError) {
      console.error(`[oauth] configuration error: ${err.message}`);
      return errorPage('The sign-in service is temporarily misconfigured. Try again shortly.', 500);
    }
    throw err;
  }

  // Neutral confirmation — identical whether or not an account exists and
  // whether or not the abuse limit was hit, matching the JSON request-link
  // endpoint's no-enumeration posture.
  return oauthPage(
    'check your email',
    `
    <h1>check your email</h1>
    <p>If that address can sign in, a one-time link is on its way. Open it in
    this browser to approve the connection.</p>
    <p class="muted">The link expires in 15 minutes and works once. You can
    close this tab after following the link.</p>
  `,
  );
}

// ── Consent page (GET /authorize/consent, submitted to POST /authorize/consent) ──

/**
 * `GET /authorize/consent` — the token-free consent page.
 *
 * The magic-link callback (`src/index.ts`) does NOT render consent at its own
 * `?token=<magic-link-token>` URL: under the flow-wide `same-origin` referrer
 * policy the consent form's same-origin POST would carry that token to
 * same-origin request logs via `Referer`. Instead the callback stashes a
 * single-use consent handoff and 303-redirects here with an opaque
 * `hosted_consent` cookie naming it (`src/http.ts`). This handler reads the
 * cookie, consumes the handoff (single-use, like the magic link itself), and
 * renders the consent page — so nothing identifying the request or the user is
 * ever in a URL. It also clears the now-consumed cookie. A missing cookie or a
 * spent/expired handoff falls through to the "restart the connection" page.
 */
export async function handleConsentPage(request: Request, env: Env): Promise<Response> {
  const handoffId = consentCookie(request);
  if (!handoffId) {
    return errorPage('This authorisation request has expired. Restart the connection from your client.');
  }
  const handoff = await consumeConsentHandoff(env.HOSTED_USERS, handoffId);
  if (!handoff) {
    return errorPage('This authorisation request has expired. Restart the connection from your client.');
  }
  const res = await renderConsentPage(env, handoff.authRequestId, handoff.userId);
  // The handoff is already consumed server-side; drop the browser's dead pointer.
  res.headers.append('set-cookie', clearConsentCookieHeader());
  return res;
}

/**
 * Render the consent page for a pending authorization request, once the user's
 * identity has been established by the magic-link callback (`src/index.ts`) and
 * carried here through the token-free handoff (`handleConsentPage` above).
 * A short-lived full session token is minted and embedded as a hidden field:
 * it is the proof of identity the consent POST carries, kept out of the URL
 * exactly like the H5 connect flow's token handling. Returns an error page if
 * the pending request has vanished (expired between email and click).
 */
export async function renderConsentPage(env: Env, reqId: string, userId: string): Promise<Response> {
  const pending = await getPendingRequest(env.HOSTED_USERS, reqId);
  if (!pending || pending.expiresAt <= nowSeconds()) {
    return errorPage('This authorisation request has expired. Restart the connection from your client.');
  }
  const client = await getClient(env.HOSTED_USERS, pending.clientId);
  const who = client?.clientName ? escapeHtml(client.clientName) : 'An application';
  // The consent-identity token only needs to live long enough for the user to
  // click Approve, so it shares the request's 15-minute window.
  const { token } = await mintFullSession(env, userId, OAUTH_REQUEST_TTL_SECONDS);

  return oauthPage(
    'approve connection',
    `
    <h1>approve connection</h1>
    <p>You are signed in. ${who} is requesting access to your affiliate-mcp
    hosted account.</p>
    <div class="note">Approving lets this client act on affiliate-mcp with the
    same access as signing in yourself: it can read your connected networks and
    their data, add or remove connections, and manage your account. Only approve
    a client you trust. You can revoke access at any time from your dashboard, or
    by removing the connector in your client.</div>
    <form class="inline" method="post" action="/authorize/consent">
      <input type="hidden" name="auth_req" value="${escapeHtml(reqId)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input type="hidden" name="decision" value="approve">
      <button class="btn p" type="submit">approve</button>
    </form>
    <form class="inline" method="post" action="/authorize/consent">
      <input type="hidden" name="auth_req" value="${escapeHtml(reqId)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input type="hidden" name="decision" value="deny">
      <button class="btn ghost" type="submit">deny</button>
    </form>
  `,
  );
}

// ── POST /authorize/consent ──────────────────────────────────────────────────

export async function handleConsent(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage('Could not read the submitted form.');
  }
  const reqId = form.get('auth_req');
  const token = form.get('token');
  const decision = form.get('decision');
  if (typeof reqId !== 'string' || reqId.length === 0) {
    return errorPage('Missing authorisation request.');
  }

  const pending = await getPendingRequest(env.HOSTED_USERS, reqId);
  if (!pending || pending.expiresAt <= nowSeconds()) {
    return errorPage('This authorisation request has expired. Restart the connection from your client.');
  }

  // Identity proof: the short-lived full session token minted on the consent
  // page. A digest-scoped token is refused exactly like an invalid one — the
  // same full-scope requirement the connect flow enforces.
  if (typeof token !== 'string' || token.length === 0) {
    return errorPage('Your session could not be verified. Restart the connection from your client.');
  }
  const payload = await resolveValidSession(token, env.SESSION_SIGNING_KEY);
  if (!payload || sessionScope(payload) !== 'full') {
    return errorPage('Your session has expired. Restart the connection from your client.');
  }

  // Single-use: the pending request is consumed on either decision, so a
  // reused consent form cannot mint a second code.
  await deletePendingRequest(env.HOSTED_USERS, reqId);

  if (decision !== 'approve') {
    return redirectWithError(pending.redirectUri, 'access_denied', 'The user denied the request.', pending.state);
  }

  const codeRecord: AuthCodeRecord = {
    clientId: pending.clientId,
    userId: payload.sub,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: 'S256',
    scope: pending.scope,
    ...(pending.resource ? { resource: pending.resource } : {}),
    expiresAt: nowSeconds() + OAUTH_CODE_TTL_SECONDS,
  };
  const code = await issueAuthCode(env.HOSTED_USERS, codeRecord);

  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);
  return redirectResponse(url.toString());
}

// ── POST /token ──────────────────────────────────────────────────────────────

function tokenError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, { status }, oauthCors());
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    // Workers' formData() parses application/x-www-form-urlencoded, which is
    // the OAuth token-endpoint content type (RFC 6749 §4.1.3).
    form = await request.formData();
  } catch {
    return tokenError('invalid_request', 'Body must be application/x-www-form-urlencoded.');
  }

  const grantType = field(form, 'grant_type');
  if (grantType === 'authorization_code') return tokenFromAuthCode(env, form);
  if (grantType === 'refresh_token') return tokenFromRefresh(env, form);
  return tokenError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
}

/** Read a single string field from a FormData, or null. A file part (never
 * expected on this endpoint) reads as null rather than a `File` object. */
function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function tokenFromAuthCode(env: Env, form: FormData): Promise<Response> {
  const code = field(form, 'code');
  const redirectUri = field(form, 'redirect_uri');
  const clientId = field(form, 'client_id');
  const codeVerifier = field(form, 'code_verifier');

  if (!code) return tokenError('invalid_request', 'Missing code.');
  if (!clientId) return tokenError('invalid_request', 'Missing client_id.');
  if (!isValidCodeVerifier(codeVerifier)) return tokenError('invalid_request', 'Missing or malformed code_verifier.');

  const record = await consumeAuthCode(env.HOSTED_USERS, code);
  if (!record) return tokenError('invalid_grant', 'The authorization code is invalid, expired, or already used.');
  if (record.clientId !== clientId) return tokenError('invalid_grant', 'client_id does not match the authorization code.');
  if (!redirectUri || record.redirectUri !== redirectUri) {
    return tokenError('invalid_grant', 'redirect_uri does not match the authorization request.');
  }

  const pkceOk = await verifyPkceS256(codeVerifier, record.codeChallenge);
  if (!pkceOk) return tokenError('invalid_grant', 'PKCE verification failed.');

  return issueTokenPair(env, record.userId, record.clientId, record.scope, record.resource);
}

async function tokenFromRefresh(env: Env, form: FormData): Promise<Response> {
  const refreshToken = field(form, 'refresh_token');
  const clientId = field(form, 'client_id');
  if (!refreshToken) return tokenError('invalid_request', 'Missing refresh_token.');

  const record = await consumeRefreshToken(env.HOSTED_USERS, refreshToken);
  if (!record) return tokenError('invalid_grant', 'The refresh token is invalid, expired, or already used.');
  // A public client should send its client_id; if it does, it must match the
  // token's. (RFC 6749 §6.) If omitted we still honour the token, since the
  // opaque, single-use, rotated token is itself the proof.
  if (clientId && clientId !== record.clientId) {
    return tokenError('invalid_grant', 'client_id does not match the refresh token.');
  }

  return issueTokenPair(env, record.userId, record.clientId, record.scope, record.resource);
}

/** Issue an access token (short-lived full session) and a fresh refresh token,
 * as the RFC 6749 §5.1 token response. `expires_in` is the access token's
 * lifetime in seconds. */
async function issueTokenPair(
  env: Env,
  userId: string,
  clientId: string,
  scope: string,
  resource: string | undefined,
): Promise<Response> {
  const { token: accessToken } = await mintFullSession(env, userId, OAUTH_ACCESS_TOKEN_TTL_SECONDS);
  const refreshRecord: RefreshRecord = {
    userId,
    clientId,
    scope,
    ...(resource ? { resource } : {}),
    expiresAt: nowSeconds() + OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  };
  const refreshToken = await issueRefreshToken(env.HOSTED_USERS, refreshRecord);

  return json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    },
    { status: 200 },
    oauthCors(),
  );
}
