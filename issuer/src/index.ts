/**
 * affiliate-mcp licence-issuer Worker.
 *
 * Endpoints:
 *   POST /checkout  → create a Stripe Checkout Session, return { url }
 *   POST /webhook   → verify Stripe sig; on checkout.session.completed, mint +
 *                     sign + store + email the licence (idempotent)
 *   GET  /success   → HTML page: looks up the licence by session_id and shows
 *                     the token + activate deep-link
 *   POST /resend     → neutral 200, re-send licence by email (no enumeration)
 *   GET  /resend     → tiny HTML form
 *
 * Holds purchase records (KV) + the signing private key (secret). NO affiliate
 * credentials ever touch this Worker.
 */

import Stripe from 'stripe';

import type { Env } from './env.js';
import { sendLicenceEmail } from './email.js';
import { buildPayload, generateLid, signLicence, todayIssued } from './licence.js';

const STRIPE_API_VERSION = '2026-03-25.dahlia';

/** Stored purchase record. */
interface LicenceRecord {
  lid: string;
  token: string;
  issued: string;
}

// ── Stripe client (Workers runtime: fetch HTTP client + WebCrypto provider) ──
function makeStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
  });
}

// ── CORS ─────────────────────────────────────────────────────────────────
// The desktop app POSTs from an Electron/file:// origin. Browsers send
// `Origin: null` for file:// and `app://…` for packaged Electron. Allow those
// plus any operator-configured extras. We reflect the request origin when
// allowed so credentials/preflight behave.
function corsHeaders(env: Env, requestOrigin: string | null): Record<string, string> {
  const extra = (env.EXTRA_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set<string>(['null', 'app://-', 'file://', ...extra]);

  // Electron app origins vary; treat null/file/app as the desktop app and
  // reflect anything explicitly allow-listed. Default to "*" for the simple
  // case (no credentials are used — the API is unauthenticated POSTs).
  let allowOrigin = '*';
  if (requestOrigin) {
    if (allowed.has(requestOrigin) || requestOrigin.startsWith('app://')) {
      allowOrigin = requestOrigin;
    } else {
      allowOrigin = requestOrigin; // unauthenticated API — reflect to ease the Electron case
    }
  }

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(body: unknown, init: ResponseInit = {}, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...cors, ...(init.headers ?? {}) },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// ── KV helpers ─────────────────────────────────────────────────────────────
const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
const lidKey = (lid: string) => `lid:${lid}`;
const evtKey = (id: string) => `evt:${id}`;

async function getRecordByEmail(env: Env, email: string): Promise<LicenceRecord | null> {
  const raw = await env.LICENCES.get(emailKey(email));
  return raw ? (JSON.parse(raw) as LicenceRecord) : null;
}

// ── POST /checkout ───────────────────────────────────────────────────────
async function handleCheckout(env: Env, cors: Record<string, string>): Promise<Response> {
  const stripe = makeStripe(env);

  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = env.STRIPE_PRICE_ID
    ? { price: env.STRIPE_PRICE_ID, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: 3900,
          product_data: { name: 'affiliate-mcp desktop (lifetime licence)' },
        },
      };

  const successUrl =
    env.SUCCESS_URL +
    (env.SUCCESS_URL.includes('?') ? '&' : '?') +
    'session_id={CHECKOUT_SESSION_ID}';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      success_url: successUrl,
      cancel_url: env.CANCEL_URL,
    });
    return json({ url: session.url }, { status: 200 }, cors);
  } catch (err) {
    console.error(`[checkout] ${(err as Error).message}`);
    return json({ error: 'checkout_failed' }, { status: 502 }, cors);
  }
}

// ── POST /webhook ──────────────────────────────────────────────────────────
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });

  const rawBody = await request.text(); // raw body, never the parsed JSON
  const stripe = makeStripe(env);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error(`[webhook] signature verification failed: ${(err as Error).message}`);
    return new Response('invalid signature', { status: 400 });
  }

  // Idempotency: ignore duplicate event ids.
  if (await env.LICENCES.get(evtKey(event.id))) {
    return new Response('ok (duplicate)', { status: 200 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_details?.email ?? session.customer_email ?? null;

    if (!email) {
      console.error('[webhook] checkout.session.completed with no email');
      // Mark processed so we don't retry forever on an un-fixable event.
      await env.LICENCES.put(evtKey(event.id), '1', { expirationTtl: 60 * 60 * 24 * 30 });
      return new Response('ok (no email)', { status: 200 });
    }

    // Upsert by email: if a record already exists, reuse it (idempotent across
    // genuinely-distinct events for the same buyer).
    let record = await getRecordByEmail(env, email);
    if (!record) {
      const lid = generateLid();
      const issued = todayIssued();
      const token = await signLicence(buildPayload({ lid, email, issued }), env.LICENCE_SIGNING_KEY);
      record = { lid, token, issued };
      await env.LICENCES.put(emailKey(email), JSON.stringify(record));
      await env.LICENCES.put(lidKey(lid), email.trim().toLowerCase());
    }

    await sendLicenceEmail(env, email, record.token);
  }

  await env.LICENCES.put(evtKey(event.id), '1', { expirationTtl: 60 * 60 * 24 * 30 });
  return new Response('ok', { status: 200 });
}

// ── GET /success ───────────────────────────────────────────────────────────
async function handleSuccess(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');

  let record: LicenceRecord | null = null;
  if (sessionId) {
    try {
      const stripe = makeStripe(env);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const email = session.customer_details?.email ?? session.customer_email ?? null;
      if (email) record = await getRecordByEmail(env, email);
    } catch (err) {
      console.error(`[success] session lookup failed: ${(err as Error).message}`);
    }
  }

  return html(successPage(record));
}

// ── /resend ─────────────────────────────────────────────────────────────────
async function handleResendPost(request: Request, env: Env): Promise<Response> {
  // Neutral 200 always — avoid email enumeration.
  const neutral = () =>
    json({ message: "If that email bought a licence, we've re-sent it." }, { status: 200 });

  let email: string | undefined;
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email === 'string') email = body.email;
    } else {
      const form = await request.formData();
      const v = form.get('email');
      if (typeof v === 'string') email = v;
    }
  } catch {
    return neutral();
  }

  if (email) {
    const record = await getRecordByEmail(env, email);
    if (record) await sendLicenceEmail(env, email, record.token);
  }
  return neutral();
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /checkout
    if (url.pathname === '/checkout' && request.method === 'POST') {
      return handleCheckout(env, cors);
    }

    // POST /webhook
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    // GET /success
    if (url.pathname === '/success' && request.method === 'GET') {
      return handleSuccess(request, env);
    }

    // /resend
    if (url.pathname === '/resend') {
      if (request.method === 'POST') return handleResendPost(request, env);
      if (request.method === 'GET') return html(resendPage());
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('affiliate-mcp licence issuer', { status: 200 });
    }

    return new Response('not found', { status: 404 });
  },
};

// ── HTML (design-system look: hard corners, mono, Riso Blue #2B2BFF) ────────
const PAGE_HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --ink:#0a0a0a; --blue:#2B2BFF; --paper:#fff; --grey:#f4f4f4; }
  * { box-sizing:border-box; }
  body { font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
         background:var(--paper); color:var(--ink); margin:0; padding:40px 20px;
         display:flex; justify-content:center; }
  .card { width:100%; max-width:640px; border:2px solid var(--ink); padding:28px;
          box-shadow:6px 6px 0 var(--ink); background:var(--paper); }
  h1 { font-size:22px; font-weight:700; margin:0 0 4px; text-transform:lowercase; }
  p { font-size:14px; line-height:1.55; }
  .key { background:var(--grey); border:2px solid var(--ink); padding:14px; font-size:13px;
         white-space:pre-wrap; word-break:break-all; margin:18px 0; }
  .btn { display:inline-block; background:var(--blue); color:#fff; text-decoration:none;
         padding:12px 18px; border:2px solid var(--ink); font-weight:700; cursor:pointer;
         font-family:inherit; font-size:14px; }
  .btn.copy { background:var(--paper); color:var(--ink); margin-right:10px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:8px; }
  label { display:block; font-size:13px; margin-bottom:6px; }
  input[type=email] { width:100%; padding:12px; border:2px solid var(--ink); font-family:inherit;
                      font-size:14px; margin-bottom:14px; }
  .muted { color:#555; font-size:12px; }
</style>`;

function successPage(record: LicenceRecord | null): string {
  if (record) {
    const token = escapeHtml(record.token);
    const deepLink = `affiliate-mcp://activate?key=${encodeURIComponent(record.token)}`;
    return `<!doctype html><html lang="en"><head>${PAGE_HEAD}<title>licence ready</title></head>
<body><div class="card">
  <h1>your licence is ready</h1>
  <p>Thank you for buying affiliate-mcp desktop. Copy this key into the app's Activate screen, or use the button to hand it straight back to the app. We've also emailed it to you.</p>
  <div class="key" id="key">${token}</div>
  <div class="row">
    <button class="btn copy" onclick="copyKey()">copy key</button>
    <a class="btn" href="${escapeHtml(deepLink)}">activate in the app</a>
  </div>
  <p class="muted">Issued ${escapeHtml(record.issued)} · licence id ${escapeHtml(record.lid)}. The key works forever and offline.</p>
</div>
<script>
  function copyKey(){
    var t=document.getElementById('key').textContent;
    navigator.clipboard.writeText(t).then(function(){
      var b=document.querySelector('.btn.copy'); var o=b.textContent; b.textContent='copied';
      setTimeout(function(){b.textContent=o;},1500);
    });
  }
</script>
</body></html>`;
  }
  // Webhook race fallback.
  return `<!doctype html><html lang="en"><head>${PAGE_HEAD}<title>licence on its way</title></head>
<body><div class="card">
  <h1>payment received</h1>
  <p>Your licence is on its way by email — it usually arrives within a minute. Once it lands, paste the key into the app's Activate screen.</p>
  <p class="muted">Didn't get it? Use the <a href="/resend">resend page</a> to have it sent again.</p>
</div></body></html>`;
}

function resendPage(): string {
  return `<!doctype html><html lang="en"><head>${PAGE_HEAD}<title>resend licence</title></head>
<body><div class="card">
  <h1>resend your licence</h1>
  <p>Enter the email you bought with and we'll re-send your licence key.</p>
  <form method="POST" action="/resend">
    <label for="email">email</label>
    <input id="email" name="email" type="email" required placeholder="you@example.com">
    <button class="btn" type="submit">resend licence</button>
  </form>
  <p class="muted">For privacy we always show the same message, whether or not that email has a licence.</p>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
