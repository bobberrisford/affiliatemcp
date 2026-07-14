/**
 * H5 guided connect flow (`docs/product/hosted-mvp-workstream.md`, slice H5):
 * server-rendered HTML pages, no client framework, no external resources,
 * matching the minimal style of the H2 callback page
 * (`renderSessionPage` in `../index.ts`).
 *
 *   GET  /connect                          sign-in prompt, or (with an
 *                                          Authorization header) the network list
 *   POST /connect                          network list + connection status
 *   POST /connect/:network/form            guided credential form for one network
 *   GET  /connect/:network                 same form, Authorization-header callers only
 *   POST /connect/:network                 store the credential, then connection-test it
 *   POST /connect/:network/retest          re-run the connection test on the stored credential
 *   GET  /connect/:network/retest          same, Authorization-header callers only
 *
 * Session gating: every route above requires a valid hosted session, exactly
 * like every H3 vault route (`requireSession`, `../guard.js`), verified with
 * the identical primitive, `resolveValidSession` from `../token.js`. Nothing
 * about "what counts as a valid session" changes; only how the token arrives
 * does. An unauthenticated visitor sees a sign-in prompt page rather than
 * `requireSession`'s JSON 401, since a human browsing this page needs an
 * explanation and a way forward, not a JSON body.
 *
 * Token transport — header or POST body only, NEVER URLs (RFC 6750 §2.3):
 * the hosted session token is a 30-day full-account bearer credential (it
 * can call the vault reveal route and `DELETE /account`), so it must never
 * appear in a URL: request URLs land verbatim in Cloudflare request logs
 * (`wrangler tail`, Logpush), browser history, and bookmarks, and URLs leak
 * outbound via the Referer header. `resolveBrowserSession` therefore accepts
 * the token from exactly two places: the `Authorization: Bearer` header
 * (parity with every API route, and with any non-browser caller) or a hidden
 * `token` field in a POST body. There is deliberately NO query-parameter
 * fallback. Because a plain HTML page cannot attach a header to a link
 * without JavaScript (which this flow deliberately avoids), every navigation
 * between these pages — back-links, connect/manage, retest — is rendered as
 * a small inline POST form carrying the hidden token field, never a GET link
 * with the token in it, and no form `action` URL ever carries the token
 * either. As defence in depth, every page in this flow is served with
 * `Referrer-Policy: no-referrer` (see `page()` below), so even this flow's
 * token-free URLs leak nothing to the external documentation links these
 * pages contain. The GET variants of the list/form/retest routes exist only
 * for callers that CAN send an Authorization header; a browser without one
 * simply sees the sign-in prompt.
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
import { bearerToken, html } from '../http.js';
import { testConnection, type ConnectionTestResult } from '../connect-test.js';
import { CONNECT_NETWORKS, findConnectNetwork, type ConnectNetwork } from '../networks.js';
import { getCredentials, isValidCredentialRecord, listNetworks, putCredentials } from '../vault.js';
import { resolveValidSession } from '../token.js';

// ── Shared page chrome ──────────────────────────────────────────────────────
// Same monospace, boxed-card look as the H2 callback page
// (`renderSessionPage` in `../index.ts`) — deliberately not factored into a
// shared constant across files, matching that file's own note that this is a
// minimal, disposable style, not a design system.
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
  input[type="text"], input[type="password"] {
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

function escapeHtml(value: string): string {
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
 * Pages in this flow embed the session token in hidden form fields and (on
 * the success page) a copyable textarea; the token never appears in any URL
 * (see the file header), and suppressing the Referer entirely means even the
 * token-free URLs here leak nothing outbound through the external
 * documentation links these pages contain.
 */
function page(title: string, bodyHtml: string): Response {
  const res = html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`);
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}

// ── Session resolution (browser-flavoured; see file header) ────────────────

export interface BrowserSession {
  userId: string;
  /** The exact token string that authenticated this request, threaded through
   * so hidden form fields can carry it forward. Never placed in a URL. */
  token: string;
}

/**
 * Parse the request body as form data when the method is POST. Returns null
 * for a non-POST request or an unreadable body. Parsed once per request and
 * threaded through, because a request body can only be consumed once.
 */
async function maybeFormData(request: Request): Promise<FormData | null> {
  if (request.method !== 'POST') return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/**
 * Resolve the session from the `Authorization: Bearer` header or a `token`
 * field in the POST body — NEVER from the URL. See the file header for why a
 * query-parameter fallback is deliberately absent (RFC 6750 §2.3: bearer
 * tokens in URLs end up in request logs, history, and Referer headers).
 */
async function resolveBrowserSession(
  request: Request,
  env: Env,
  form: FormData | null,
): Promise<BrowserSession | null> {
  const formToken = form?.get('token');
  const token =
    bearerToken(request) ?? (typeof formToken === 'string' && formToken.length > 0 ? formToken : null);
  if (!token) return null;
  const payload = await resolveValidSession(token, env.SESSION_SIGNING_KEY);
  if (!payload) return null;
  return { userId: payload.sub, token };
}

function signInPromptPage(env: Env): Response {
  const front = env.SITE_ORIGIN || 'https://agenticaffiliate.ai';
  return page(
    'sign in required',
    `
    <h1>sign in required</h1>
    <p>Connecting a network needs a signed-in hosted session.</p>
    <p>Sign in at <a href="${escapeHtml(front)}">${escapeHtml(front)}</a> to request a magic
    sign-in link by email, then open the link. It leads to a page with a
    session token box and a copy button (the same one your MCP client uses to
    connect) &mdash; paste that token below to continue here.</p>
    <form method="post" action="/connect">
      <label for="token">Session token</label>
      <input type="password" id="token" name="token" placeholder="amcps_..." required>
      <button type="submit">continue</button>
    </form>
    <p class="muted">If you do not have a hosted account yet, sign-in is the same
    step that creates one: request a link for the email address you want to
    use, then follow it. The token is submitted in the request body, never in
    the page URL.</p>
  `,
  );
}

/**
 * A navigation action rendered as a minimal inline POST form: the session
 * token travels in a hidden body field, never in the URL. This is the only
 * way to move between these pages in a browser without JavaScript while
 * keeping the token out of request URLs (and therefore out of Cloudflare
 * request logs, history, bookmarks, and Referer).
 */
function navForm(action: string, token: string, label: string): string {
  return `<form class="nav" method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function notFoundPage(token: string): Response {
  return page(
    'network not found',
    `<h1>network not found</h1>
    <p>This is not one of the four hosted-eligible networks.</p>
    <p>${navForm('/connect', token, 'back to all networks')}</p>`,
  );
}

// ── GET|POST /connect ────────────────────────────────────────────────────────
export async function handleConnectList(request: Request, env: Env): Promise<Response> {
  const form = await maybeFormData(request);
  const session = await resolveBrowserSession(request, env, form);
  if (!session) return signInPromptPage(env);

  const connected = new Set(await listNetworks(env.HOSTED_VAULT, session.userId));

  const rows = CONNECT_NETWORKS.map((n) => {
    const isConnected = connected.has(n.slug);
    const statusHtml = isConnected
      ? '<span class="status-connected">connected</span>'
      : '<span class="status-not-connected">not connected</span>';
    return `<li><span>${escapeHtml(n.name)} <span class="muted">(${escapeHtml(n.claimStatus)})</span></span>
      <span>${statusHtml} ${navForm(`/connect/${n.slug}/form`, session.token, isConnected ? 'manage' : 'connect')}</span></li>`;
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
    <p class="muted">Networks are connected one at a time by design: there is
    no combined "connect all" submission. This keeps each stored credential's
    one-time data-key setup (see <code>hosted/README.md</code>, "KV storage
    shapes (H3)") free of concurrent writes for the same account.</p>
  `,
  );
}

// ── POST /connect/:network/form and GET /connect/:network ───────────────────
export async function handleConnectForm(request: Request, env: Env, slug: string): Promise<Response> {
  const form = await maybeFormData(request);
  const session = await resolveBrowserSession(request, env, form);
  if (!session) return signInPromptPage(env);

  const network = findConnectNetwork(slug);
  if (!network) return notFoundPage(session.token);

  const alreadyConnected =
    (await getCredentials(env.HOSTED_VAULT, vaultMasterKeyProvider(env), session.userId, network.slug)) !== null;

  return page(`connect ${network.name}`, renderConnectFormBody(network, session.token, alreadyConnected));
}

function renderConnectFormBody(
  network: ConnectNetwork,
  token: string,
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
       ${navForm(`/connect/${network.slug}/retest`, token, 'run the connection test again')}</div>`
    : '';

  return `
    <h1>connect ${escapeHtml(network.name)}</h1>
    <p>${navForm('/connect', token, 'back to all networks')}</p>
    <div class="note">${escapeHtml(network.leastPrivilegeNote)}</div>
    ${connectedHtml}
    ${errorHtml}
    <form method="post" action="/connect/${network.slug}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
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
  const session = await resolveBrowserSession(request, env, form);
  if (!session) return signInPromptPage(env);

  const network = findConnectNetwork(slug);
  if (!network) return notFoundPage(session.token);
  if (!form) {
    return page(
      `connect ${network.name}`,
      renderConnectFormBody(network, session.token, false, 'Could not read the submitted form. Nothing was stored.'),
    );
  }

  // Build the credential record from exactly this network's declared fields
  // — nothing else in the submitted form (e.g. the `token` field itself) ever
  // reaches the vault. One network, one call: this is the SEQUENTIAL store
  // the file header describes; there is no path that stores more than one
  // network's credential per request.
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
      renderConnectFormBody(network, session.token, false, 'All fields are required. Nothing was stored.'),
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
      renderConnectFormBody(network, session.token, false, 'Could not store the credential. Nothing was tested. Try again.'),
    );
  }

  // Connection test on save, using the plaintext just submitted — this avoids
  // an unnecessary extra decrypt round-trip and is gone from memory the
  // instant this handler returns. The credential is stored regardless of the
  // test result: a failing test never un-stores what was just saved, per the
  // task's "keep the credential stored" requirement.
  const result = await testConnection(network.slug, record);
  const maskedTail = maskLastFour(record[network.maskedConfirmationField] ?? '');
  return page(`connect ${network.name}`, renderConnectResultBody(network, session.token, result, maskedTail));
}

// ── POST|GET /connect/:network/retest ────────────────────────────────────────
export async function handleConnectRetest(request: Request, env: Env, slug: string): Promise<Response> {
  const form = await maybeFormData(request);
  const session = await resolveBrowserSession(request, env, form);
  if (!session) return signInPromptPage(env);

  const network = findConnectNetwork(slug);
  if (!network) return notFoundPage(session.token);

  const provider = vaultMasterKeyProvider(env);
  const stored = await getCredentials(env.HOSTED_VAULT, provider, session.userId, network.slug);
  if (!stored) {
    return page(
      `connect ${network.name}`,
      `<h1>not connected</h1><p>${escapeHtml(network.name)} has not been connected yet.</p>
       <p>${navForm(`/connect/${network.slug}/form`, session.token, 'connect it now')}</p>`,
    );
  }

  const result = await testConnection(network.slug, stored);
  const maskedTail = maskLastFour(stored[network.maskedConfirmationField] ?? '');
  return page(`connect ${network.name}`, renderConnectResultBody(network, session.token, result, maskedTail));
}

function renderConnectResultBody(
  network: ConnectNetwork,
  token: string,
  result: ConnectionTestResult,
  maskedTail: string,
): string {
  const maskedLine = maskedTail
    ? `<p class="muted">Stored credential ending in &bull;&bull;&bull;&bull;${escapeHtml(maskedTail)}.</p>`
    : '';

  if (result.ok) {
    return `
      <h1>${escapeHtml(network.name)} connected</h1>
      <p class="status-connected">Connection test passed.</p>
      ${maskedLine}
      <h2>connect your MCP client</h2>
      <p>Copy your hosted session token into your MCP client's connection
      settings, alongside the transport URL below (the H4 remote MCP
      transport &mdash; see <code>src/hosted-transport/</code> in the root
      workspace).</p>
      <textarea readonly rows="4">${escapeHtml(token)}</textarea>
      <p class="muted">Transport URL: <code>https://&lt;your-hosted-transport-deployment&gt;/mcp</code>
      &mdash; a placeholder until a staging or production deployment exists
      (H4 has not been deployed yet; see
      <code>docs/product/hosted-mvp-workstream.md</code>, slice H4).</p>
      <p>Suggested first prompt once connected: "Show my unpaid commissions on
      ${escapeHtml(network.name)} from the last 30 days."</p>
      <div class="note">This page cannot run that prompt for you: a full
      automatic first-value report needs the Node H4 transport runtime, which
      is out of this Worker's scope. State this honestly rather than fake a
      report &mdash; run the prompt yourself once your MCP client is connected.</div>
      <p>${navForm('/connect', token, 'back to all networks')}</p>
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
    <p>${navForm(`/connect/${network.slug}/retest`, token, 'retry the connection test')}
    ${navForm(`/connect/${network.slug}/form`, token, 'edit the credential')}</p>
  `;
}

function maskLastFour(value: string): string {
  if (value.length <= 4) return '';
  return value.slice(-4);
}
