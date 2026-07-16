/**
 * H5 guided connect flow (`docs/product/hosted-mvp-workstream.md`, slice H5):
 * server-rendered HTML pages, no client framework, no external resources.
 *
 *   GET  /connect                          sign-in prompt, or (authenticated)
 *                                          the network list
 *   POST /connect                          network list + connection status
 *   POST /connect/signin                   email a magic sign-in link for the
 *                                          dashboard (no token to paste)
 *   POST /connect/:network/form            guided credential form for one network
 *   GET  /connect/:network                 same form, Authorization-header callers only
 *   POST /connect/:network                 store the credential, then connection-test it
 *   POST /connect/:network/retest          re-run the connection test on the stored credential
 *   GET  /connect/:network/retest          same, Authorization-header callers only
 *
 * Session gating: every route above requires a valid, full-scope hosted
 * session, exactly like every H3 vault route (`requireFullSession`,
 * `../guard.js`), verified with the identical primitive, `resolveValidSession`
 * from `../token.js`. Nothing about "what counts as a valid session" changes;
 * only how the session arrives does. An unauthenticated visitor sees a sign-in
 * prompt page rather than `requireSession`'s JSON 401, since a human browsing
 * this page needs an explanation and a way forward, not a JSON body.
 *
 * Session transport — HttpOnly cookie, never a URL, body, or page (slice 3,
 * `docs/decisions/2026-07-15-hosted-connector-oauth.md`): the browser dashboard
 * authenticates via the `hosted_session` cookie, set `HttpOnly; Secure;
 * SameSite=Strict; Path=/` at the plain sign-in callback (`../index.ts`,
 * `setSessionCookieHeader` in `../http.js`). The token itself is never rendered
 * into any page, never placed in a URL, and never carried in a form body — the
 * browser re-presents the cookie automatically on every same-site navigation,
 * so no in-page token handling remains. This replaces the earlier "token in a
 * hidden POST field" design, which was the reviewed interim the connect flow
 * flagged as a cookie-upgrade candidate; slice 3 is that upgrade.
 * `resolveBrowserSession` reads the cookie first, then falls back to an
 * `Authorization: Bearer` header for the header-authenticated GET variants and
 * any non-browser caller. There is deliberately NO query-parameter fallback
 * (RFC 6750 §2.3: bearer tokens in URLs land in Cloudflare request logs,
 * history, bookmarks, and Referer).
 *
 * CSRF: `SameSite=Strict` already stops a cross-site page from attaching the
 * cookie to a forged navigation. As defence in depth, the state-changing POSTs
 * — `POST /connect/:network` (stores a credential) and the two billing action
 * POSTs (`../billing-page.js`) — additionally require a same-origin `Origin`
 * (or `Referer`) via `sameOriginPost` (`../http.js`) and return a 403 page
 * otherwise. Pure-navigation and idempotent POSTs (`/connect` list,
 * `/connect/:network/form`, `/retest`) do not need the check. Every page in
 * this flow is served `Referrer-Policy: no-referrer` on top of the Worker-wide
 * `cache-control: no-store`, so its token-free URLs leak nothing outbound
 * through the external documentation links these pages contain. The GET
 * variants of the list/form/retest routes exist only for callers that CAN send
 * an Authorization header; a browser without a cookie simply sees the sign-in
 * prompt.
 *
 * Sequential-store requirement (the H3 data-key race): `hosted/README.md`'s
 * "KV storage shapes (H3)" section records that two concurrent first-ever
 * `putCredentials` calls for the same user can each mint a data key and race
 * the single `vault:key:<userId>` write, silently orphaning the loser's
 * credential blob. `putCredentials` itself has no locking — the compensating
 * control named there is that H5's connect flow stores credentials
 * SEQUENTIALLY per user, one network at a time. This file enforces that by
 * construction, not by convention: there is no route that accepts more than
 * one network's credentials in a single request (see `handleConnectSubmit`
 * below), and the connect list page (`handleConnectList`) only ever offers
 * one network's form at a time. A user connecting all four networks makes
 * four separate page loads and four separate POSTs, never a batch call.
 *
 * Never logs a credential value, on any path, on success or failure.
 */

import type { Env } from '../env.js';
import { vaultMasterKeyProvider } from '../env.js';
import { bearerToken, cookieToken, html, sameOriginPost } from '../http.js';
import { dispatchMagicLink, MagicLinkConfigError } from '../auth-link.js';
import { isValidEmail, normaliseEmail } from '../identity.js';
import { testConnection, type ConnectionTestResult } from '../connect-test.js';
import { CONNECT_NETWORKS, findConnectNetwork, type ConnectNetwork } from '../networks.js';
import { getCredentials, isValidCredentialRecord, listNetworks, putCredentials } from '../vault.js';
import { resolveValidSession, sessionScope } from '../token.js';
import { resolveEntitlement, type HostedTier } from '../billing.js';

// ── Shared page chrome ──────────────────────────────────────────────────────
// Same monospace, boxed-card look as the OAuth ceremony pages
// (`src/routes/oauth.ts`) and the H2 error page (`../index.ts`) — deliberately
// not factored into a shared constant across files, a minimal, disposable
// style, not a design system.
const PAGE_STYLE = `
  body { font-family:'JetBrains Mono',ui-monospace,Menlo,monospace; background:#fff; color:#0a0a0a;
         margin:0; padding:40px 20px; display:flex; justify-content:center; }
  .card { width:100%; max-width:640px; border:2px solid #0a0a0a; padding:28px; box-shadow:6px 6px 0 #0a0a0a; }
  h1 { font-size:22px; font-weight:700; margin:0 0 4px; text-transform:lowercase; }
  h2 { font-size:16px; font-weight:700; margin:20px 0 8px; }
  p { font-size:14px; line-height:1.55; }
  .muted { color:#555; font-size:12px; }
  label { display:block; font-size:13px; font-weight:700; margin:14px 0 4px; }
  .field-help { font-size:12px; color:#555; margin:2px 0 6px; }
  input[type="text"], input[type="password"], input[type="email"] {
    width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; padding:8px;
    border:1px solid #0a0a0a;
  }
  textarea { width:100%; box-sizing:border-box; font-family:inherit; font-size:12px; padding:10px;
             border:1px solid #0a0a0a; margin:12px 0; }
  button { font-family:inherit; font-size:13px; padding:8px 14px; border:2px solid #0a0a0a; background:#fff;
           cursor:pointer; margin-top:12px; }
  form.nav { display:inline-block; margin:0; }
  form.nav button { margin-top:0; padding:4px 10px; font-size:12px; }
  ul.network-list { list-style:none; padding:0; margin:16px 0; }
  ul.network-list li { border:1px solid #0a0a0a; padding:10px 12px; margin-bottom:8px;
                        display:flex; justify-content:space-between; align-items:center; }
  .status-connected { color:#0a6b2c; font-weight:700; }
  .status-not-connected { color:#555; }
  .status-failed { color:#8a1f11; font-weight:700; }
  .note { border:1px dashed #0a0a0a; padding:10px; font-size:12px; margin:14px 0; }
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Every connect page carries `Referrer-Policy: no-referrer` on top of the
 * Worker-wide `cache-control: no-store` inherited from `html()` (`../http.js`).
 * No page in this flow renders the session token anywhere — the browser holds
 * it in the HttpOnly `hosted_session` cookie (see the file header) — so no URL
 * or form body here carries it, and suppressing the Referer entirely means even
 * these token-free URLs leak nothing outbound through the external
 * documentation links these pages contain. `status` defaults to 200; pass 403
 * for the CSRF-rejection page and 500 for a sign-in configuration error.
 */
export function page(title: string, bodyHtml: string, status = 200): Response {
  const res = html(
    `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`,
    status,
  );
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}

// ── Session resolution (browser-flavoured; see file header) ────────────────

export interface BrowserSession {
  userId: string;
  /** The exact token string that authenticated this request (from the cookie
   * or an Authorization header). Returned for callers that need it in-process
   * — e.g. the billing page's synthetic API request (`../billing-page.js`) —
   * but NEVER rendered into a page or a URL. */
  token: string;
}

/**
 * Parse the request body as form data when the method is POST. Returns null
 * for a non-POST request or an unreadable body. Parsed once per request and
 * threaded through, because a request body can only be consumed once.
 */
export async function maybeFormData(request: Request): Promise<FormData | null> {
  if (request.method !== 'POST') return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/**
 * Resolve the session from the HttpOnly `hosted_session` cookie, falling back
 * to an `Authorization: Bearer` header — NEVER from the URL or a form body.
 * The cookie is what a browser presents automatically; the header fallback
 * serves the header-authenticated GET variants and any non-browser caller. See
 * the file header for why a query-parameter fallback is deliberately absent
 * (RFC 6750 §2.3: bearer tokens in URLs end up in request logs, history, and
 * Referer headers).
 *
 * FULL sessions only (H6): a digest-scoped token (`sessionScope`,
 * `../token.js`) is refused exactly like an invalid one — the connect pages
 * read and WRITE credentials, and the digest token's entire entitlement is
 * two vault read routes. The browser-flavoured outcome (the sign-in prompt
 * page rather than a JSON 403) is correct here: a human holding only a
 * digest token is not signed in for this flow's purposes.
 */
export async function resolveBrowserSession(
  request: Request,
  env: Env,
): Promise<BrowserSession | null> {
  const token = cookieToken(request) ?? bearerToken(request);
  if (!token) return null;
  const payload = await resolveValidSession(token, env.SESSION_SIGNING_KEY);
  if (!payload) return null;
  if (sessionScope(payload) !== 'full') return null;
  return { userId: payload.sub, token };
}

/**
 * Shared across every page in this connect family, including the billing
 * page (`./billing-page.ts`): one sign-in prompt, one wording, so "signed
 * out" reads the same regardless of which page sent the visitor here.
 * `extraNote` renders as one boxed line above the explanation, for a caller
 * with page-specific context to add (for example, the billing page's
 * Stripe-return landing: see that file for why a `checkout` status can only
 * ever be shown here, never on a fabricated "subscribed" page, since
 * Stripe's redirect cannot carry a session cookie to a fresh browser).
 *
 * There is nothing to paste. The prompt is a single email field that requests
 * a magic sign-in link (`POST /connect/signin`); following the emailed link
 * sets the HttpOnly session cookie and lands the user back on the dashboard.
 */
export function signInPromptPage(env: Env, extraNote?: string): Response {
  const front = env.SITE_ORIGIN || 'https://agenticaffiliate.ai';
  const extraHtml = extraNote ? `<div class="note">${escapeHtml(extraNote)}</div>` : '';
  return page(
    'sign in required',
    `
    <h1>sign in required</h1>
    ${extraHtml}
    <p>This dashboard needs a signed-in hosted session. Enter your email and we
    will send you a one-time sign-in link. Following it in this browser signs
    you into the dashboard &mdash; there is nothing to copy or paste.</p>
    <form method="post" action="/connect/signin">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required>
      <button type="submit">send sign-in link</button>
    </form>
    <p class="muted">Signing in by email creates a hosted account if you do not
    already have one. The link expires in 15 minutes and works once. Connecting
    an MCP client instead? Add affiliate-mcp as a custom connector there &mdash;
    you do not need this dashboard to authenticate a client. More at
    <a href="${escapeHtml(front)}">${escapeHtml(front)}</a>.</p>
  `,
  );
}

// ── POST /connect/signin (dashboard email sign-in) ──────────────────────────
/**
 * Dashboard email sign-in: sends the same magic link as the plain
 * `POST /auth/request-link` flow (no `authRequestId`, so `/auth/callback` sets
 * the session cookie and redirects to the dashboard rather than resuming an
 * OAuth consent). Neutral by construction — `dispatchMagicLink` never reveals
 * whether an account exists — so the "check your email" confirmation is
 * identical for every address. An invalid email re-renders the sign-in prompt
 * with an inline error; a `MagicLinkConfigError` is a 500 identical for every
 * caller, carrying no enumeration signal.
 */
export async function handleConnectSignin(request: Request, env: Env): Promise<Response> {
  const form = await maybeFormData(request);
  const emailRaw = form?.get('email');
  if (!isValidEmail(emailRaw)) {
    return signInPromptPage(env, 'Enter a valid email address.');
  }
  const email = normaliseEmail(emailRaw);

  try {
    await dispatchMagicLink(request, env, email);
  } catch (err) {
    if (err instanceof MagicLinkConfigError) {
      console.error(`[connect] sign-in configuration error: ${err.message}`);
      return page(
        'sign-in unavailable',
        `<h1>sign-in unavailable</h1>
        <p>The sign-in service is temporarily misconfigured. Try again shortly.</p>`,
        500,
      );
    }
    throw err;
  }

  return page(
    'check your email',
    `
    <h1>check your email</h1>
    <p>If that address can sign in, a one-time link is on its way. Open it in
    this browser to sign into the dashboard.</p>
    <p class="muted">The link expires in 15 minutes and works once. You can
    close this tab after following the link.</p>
  `,
  );
}

/**
 * A navigation action rendered as a minimal inline POST form. The session no
 * longer travels in the form at all — the browser attaches the HttpOnly
 * `hosted_session` cookie automatically (`SameSite=Strict`, so only on
 * same-site navigations) — so these forms carry no token and no `action` URL
 * ever carries one either.
 *
 * `extraFields` lets a caller carry additional hidden fields (for example, the
 * billing page's tier choice on its subscribe and upgrade buttons,
 * `./billing-page.ts`) without inventing a second navigation-form shape: one
 * POST form remains the only way this connect family moves the browser
 * anywhere.
 */
export function navForm(
  action: string,
  label: string,
  extraFields: Record<string, string> = {},
): string {
  const extraHtml = Object.entries(extraFields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  return `<form class="nav" method="post" action="${escapeHtml(action)}">
    ${extraHtml}
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

/**
 * The 403 page returned when a state-changing POST fails the same-origin CSRF
 * check (`sameOriginPost`, `../http.js`). `SameSite=Strict` already blocks a
 * cross-site page from attaching the cookie; this is the defence-in-depth
 * response for the credential-storing and billing-action POSTs.
 */
export function csrfErrorPage(): Response {
  return page(
    'request not verified',
    `<h1>request not verified</h1>
    <p>This request could not be verified. Return to the dashboard and try again.</p>
    <p>${navForm('/connect', 'back to all networks')}</p>`,
    403,
  );
}

function notFoundPage(): Response {
  return page(
    'network not found',
    `<h1>network not found</h1>
    <p>This is not one of the four hosted-eligible networks.</p>
    <p>${navForm('/connect', 'back to all networks')}</p>`,
  );
}

// ── GET|POST /connect ────────────────────────────────────────────────────────
export async function handleConnectList(request: Request, env: Env): Promise<Response> {
  const session = await resolveBrowserSession(request, env);
  if (!session) return signInPromptPage(env);

  const connected = new Set(await listNetworks(env.HOSTED_VAULT, session.userId));

  const rows = CONNECT_NETWORKS.map((n) => {
    const isConnected = connected.has(n.slug);
    const statusHtml = isConnected
      ? '<span class="status-connected">connected</span>'
      : '<span class="status-not-connected">not connected</span>';
    return `<li><span>${escapeHtml(n.name)} <span class="muted">(${escapeHtml(n.claimStatus)})</span></span>
      <span>${statusHtml} ${navForm(`/connect/${n.slug}/form`, isConnected ? 'manage' : 'connect')}</span></li>`;
  }).join('\n');

  return page(
    'connect a network',
    `
    <h1>connect a network</h1>
    <p>Connect one of the four hosted-eligible networks below. Each connection
    is stored separately and tested on save &mdash; see
    <code>hosted/README.md</code>, "Hosted eligibility: ToS check", for what
    this repo has and has not verified about each network's terms for
    third-party credential use.</p>
    <ul class="network-list">${rows}</ul>
    <p>${navForm('/connect/billing', 'billing')}</p>
    <p class="muted">Networks are connected one at a time by design: there is
    no combined "connect all" submission. This keeps each stored credential's
    one-time data-key setup (see <code>hosted/README.md</code>, "KV storage
    shapes (H3)") free of concurrent writes for the same account.</p>
  `,
  );
}

// ── POST /connect/:network/form and GET /connect/:network ───────────────────
export async function handleConnectForm(request: Request, env: Env, slug: string): Promise<Response> {
  const session = await resolveBrowserSession(request, env);
  if (!session) return signInPromptPage(env);

  const network = findConnectNetwork(slug);
  if (!network) return notFoundPage();

  const alreadyConnected =
    (await getCredentials(env.HOSTED_VAULT, vaultMasterKeyProvider(env), session.userId, network.slug)) !== null;

  return page(`connect ${network.name}`, renderConnectFormBody(network, alreadyConnected));
}

function renderConnectFormBody(
  network: ConnectNetwork,
  alreadyConnected: boolean,
  errorMessage?: string,
): string {
  const fieldsHtml = network.fields
    .map(
      (f) => `
      <label for="${escapeHtml(f.key)}">${escapeHtml(f.label)}</label>
      <div class="field-help">${escapeHtml(f.whereToFind)}</div>
      <input type="${f.inputType}" id="${escapeHtml(f.key)}" name="${escapeHtml(f.key)}"
             ${f.placeholder ? `placeholder="${escapeHtml(f.placeholder)}"` : ''} required>
    `,
    )
    .join('\n');

  const errorHtml = errorMessage ? `<div class="note">${escapeHtml(errorMessage)}</div>` : '';
  const connectedHtml = alreadyConnected
    ? `<div class="note">Already connected. Submitting again overwrites the stored
       credential and re-runs the connection test.
       ${navForm(`/connect/${network.slug}/retest`, 'run the connection test again')}</div>`
    : '';

  return `
    <h1>connect ${escapeHtml(network.name)}</h1>
    <p>${navForm('/connect', 'back to all networks')}</p>
    <div class="note">${escapeHtml(network.leastPrivilegeNote)}</div>
    ${connectedHtml}
    ${errorHtml}
    <form method="post" action="/connect/${network.slug}">
      ${fieldsHtml}
      <button type="submit">save and test connection</button>
    </form>
    <p class="muted">Docs: <a href="${escapeHtml(network.docsUrl)}">${escapeHtml(network.docsUrl)}</a>
    &middot; full setup walkthrough: <code>${escapeHtml(network.setupDocPath)}</code></p>
  `;
}

// ── POST /connect/:network ───────────────────────────────────────────────────
export async function handleConnectSubmit(request: Request, env: Env, slug: string): Promise<Response> {
  const form = await maybeFormData(request);
  const session = await resolveBrowserSession(request, env);
  if (!session) return signInPromptPage(env);
  // CSRF defence in depth for this credential-storing POST: SameSite=Strict
  // already blocks a cross-site page from attaching the cookie, but a
  // same-origin check on Origin/Referer is a cheap second gate. Pure-navigation
  // POSTs (the list, the form, retest) do not carry this check.
  if (!sameOriginPost(request, env)) return csrfErrorPage();

  const network = findConnectNetwork(slug);
  if (!network) return notFoundPage();
  if (!form) {
    return page(
      `connect ${network.name}`,
      renderConnectFormBody(network, false, 'Could not read the submitted form. Nothing was stored.'),
    );
  }

  // Build the credential record from exactly this network's declared fields —
  // nothing else in the submitted form reaches the vault. One network, one
  // call: this is the SEQUENTIAL store the file header describes; there is no
  // path that stores more than one network's credential per request.
  const record: Record<string, string> = {};
  for (const field of network.fields) {
    const value = form.get(field.key);
    if (typeof value === 'string' && value.trim().length > 0) {
      record[field.key] = value.trim();
    }
  }

  if (!isValidCredentialRecord(record) || Object.keys(record).length !== network.fields.length) {
    return page(
      `connect ${network.name}`,
      renderConnectFormBody(network, false, 'All fields are required. Nothing was stored.'),
    );
  }

  try {
    await putCredentials(env.HOSTED_VAULT, vaultMasterKeyProvider(env), session.userId, network.slug, record);
  } catch (err) {
    // Never log the credential values themselves — only the network slug and
    // the (opaque) userId, matching `src/routes/vault.ts`'s logging discipline.
    console.error(`[connect] store failed userId=${session.userId} network=${network.slug} err=${(err as Error).message}`);
    return page(
      `connect ${network.name}`,
      renderConnectFormBody(network, false, 'Could not store the credential. Nothing was tested. Try again.'),
    );
  }

  // Connection test on save, using the plaintext just submitted — this avoids
  // an unnecessary extra decrypt round-trip and is gone from memory the
  // instant this handler returns. The credential is stored regardless of the
  // test result: a failing test never un-stores what was just saved, per the
  // task's "keep the credential stored" requirement.
  const result = await testConnection(network.slug, record);
  const maskedTail = maskLastFour(record[network.maskedConfirmationField] ?? '');
  const entitlement = await resolveEntitlement(env.HOSTED_BILLING, session.userId);
  return page(`connect ${network.name}`, renderConnectResultBody(network, result, maskedTail, env, entitlement.tier));
}

// ── POST|GET /connect/:network/retest ────────────────────────────────────────
export async function handleConnectRetest(request: Request, env: Env, slug: string): Promise<Response> {
  const session = await resolveBrowserSession(request, env);
  if (!session) return signInPromptPage(env);

  const network = findConnectNetwork(slug);
  if (!network) return notFoundPage();

  const provider = vaultMasterKeyProvider(env);
  const stored = await getCredentials(env.HOSTED_VAULT, provider, session.userId, network.slug);
  if (!stored) {
    return page(
      `connect ${network.name}`,
      `<h1>not connected</h1><p>${escapeHtml(network.name)} has not been connected yet.</p>
       <p>${navForm(`/connect/${network.slug}/form`, 'connect it now')}</p>`,
    );
  }

  const result = await testConnection(network.slug, stored);
  const maskedTail = maskLastFour(stored[network.maskedConfirmationField] ?? '');
  const entitlement = await resolveEntitlement(env.HOSTED_BILLING, session.userId);
  return page(`connect ${network.name}`, renderConnectResultBody(network, result, maskedTail, env, entitlement.tier));
}

function renderConnectResultBody(
  network: ConnectNetwork,
  result: ConnectionTestResult,
  maskedTail: string,
  env: Env,
  tier: HostedTier,
): string {
  const maskedLine = maskedTail
    ? `<p class="muted">Stored credential ending in &bull;&bull;&bull;&bull;${escapeHtml(maskedTail)}.</p>`
    : '';

  if (result.ok) {
    // The connector URL a user adds in their MCP client. When the deployer has
    // set HOSTED_CONNECTOR_URL show the real transport origin; otherwise show a
    // neutral placeholder until this deployment configures it. Only ever the
    // public server URL, never a token.
    const connectorUrlHtml = env.HOSTED_CONNECTOR_URL
      ? `<p class="muted">Connector URL:
      <code>${escapeHtml(env.HOSTED_CONNECTOR_URL)}</code>. Add it via your
      client's "Add custom connector" flow.</p>`
      : `<p class="muted">Connector URL:
      <code>https://&lt;your-hosted-transport-deployment&gt;/mcp</code> &mdash;
      the exact address appears here once this deployment's
      <code>HOSTED_CONNECTOR_URL</code> is configured. Add it via your client's
      "Add custom connector" flow.</p>`;

    // The hosted MCP transport refuses tool calls without an active
    // subscription (the entitlement gate in `../billing.ts`, consulted at the
    // transport boundary). So a user who is not yet subscribed must subscribe
    // BEFORE adding the connector, or their first prompt fails at that boundary.
    // Sequence the guidance to match entitlement: `none` -> billing first;
    // `solo`/`pro` -> the full add-connector + first-prompt copy.
    if (tier === 'none') {
      return `
      <h1>${escapeHtml(network.name)} connected</h1>
      <p class="status-connected">Connection test passed.</p>
      ${maskedLine}
      <h2>next: subscribe, then add to Claude</h2>
      <p>Your ${escapeHtml(network.name)} credentials are stored and working.
      Running reports from an MCP client needs an active hosted subscription, so
      choose a plan first &mdash; then add affiliate-mcp as a custom connector,
      where your client signs you in through your browser with OAuth (there is
      no token to copy or paste).</p>
      <p>${navForm('/connect/billing', 'choose a plan')}</p>
      ${connectorUrlHtml}
      <p>${navForm('/connect', 'back to all networks')}</p>
    `;
    }

    return `
      <h1>${escapeHtml(network.name)} connected</h1>
      <p class="status-connected">Connection test passed.</p>
      ${maskedLine}
      <h2>use this from your MCP client</h2>
      <p>To use your connected networks from an MCP client (Claude, ChatGPT, and
      similar), add affiliate-mcp as a custom connector. Your client signs you
      in through your browser with OAuth &mdash; there is no token to copy or
      paste.</p>
      ${connectorUrlHtml}
      <p>Suggested first prompt once connected: "Show my unpaid commissions on
      ${escapeHtml(network.name)} from the last 30 days."</p>
      <div class="note">This page cannot run that prompt for you: a full
      automatic first-value report needs the separate hosted transport runtime,
      which is out of this Worker's scope. State this honestly rather than fake a
      report &mdash; run the prompt yourself once your MCP client is connected.</div>
      <p>${navForm('/connect', 'back to all networks')}</p>
    `;
  }

  const statusLine = result.status ? `HTTP ${result.status}` : 'no response';
  return `
    <h1>${escapeHtml(network.name)} connection test failed</h1>
    <p class="status-failed">${statusLine}</p>
    <p>${escapeHtml(result.detail)}</p>
    ${maskedLine}
    <p class="muted">The credential you submitted is still stored &mdash; this
    test failure did not remove it. Fix the value in ${escapeHtml(
      network.name,
    )}'s own dashboard if needed, then retry.</p>
    <p>${navForm(`/connect/${network.slug}/retest`, 'retry the connection test')}
    ${navForm(`/connect/${network.slug}/form`, 'edit the credential')}</p>
  `;
}

function maskLastFour(value: string): string {
  if (value.length <= 4) return '';
  return value.slice(-4);
}
