/**
 * affiliate-mcp entitlement-issuer Worker.
 *
 * Sells and verifies a £20/mo subscription; runs NO feature. Holds subscription
 * records (KV) + the signing key (secret) only. NO affiliate credentials and NO
 * affiliate data ever touch this Worker.
 *
 * Endpoints:
 *   POST /checkout     → create a Stripe subscription Checkout Session; return
 *                        { url, accountKey }. The app stores accountKey up front
 *                        and polls /entitlement after the user pays.
 *   POST /webhook      → verify Stripe sig; mirror subscription lifecycle into KV.
 *   POST /entitlement  → { accountKey } → { active, token?, exp? }. Signs a
 *                        SHORT-LIVED entitlement token only while the sub is live.
 *   POST /portal       → { accountKey } → { url } Stripe billing portal (cancel/manage).
 *   GET  /success      → minimal "you're subscribed, return to the app" page.
 *   GET  /health       → liveness.
 */

import Stripe from 'stripe';

import type { Env } from './env.js';
import { buildEntitlement, generateAccountKey, signEntitlement } from './token.js';

const STRIPE_API_VERSION = '2026-03-25.dahlia';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 8; // 8 days (> the app's 7-day grace)

/** Stored subscription record, keyed by account key. */
interface SubRecord {
  status: string; // Stripe subscription status, or 'pending' before first event
  customerId?: string;
  subscriptionId?: string;
  email?: string;
}

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const isActive = (status: string | undefined): boolean => !!status && ACTIVE_STATUSES.has(status);

function makeStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
  });
}

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  // The desktop app POSTs from an Electron/file:// origin. The API is an
  // unauthenticated bearer-key POST, so reflecting the origin is safe.
  const allowOrigin = requestOrigin || '*';
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
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ── KV helpers ─────────────────────────────────────────────────────────────
const accKey = (akey: string) => `acc:${akey}`;
const subKey = (subId: string) => `sub:${subId}`;
const evtKey = (id: string) => `evt:${id}`;

async function getRecord(env: Env, akey: string): Promise<SubRecord | null> {
  const raw = await env.ENTITLEMENTS.get(accKey(akey));
  return raw ? (JSON.parse(raw) as SubRecord) : null;
}

async function putRecord(env: Env, akey: string, record: SubRecord): Promise<void> {
  await env.ENTITLEMENTS.put(accKey(akey), JSON.stringify(record));
}

// ── POST /checkout ───────────────────────────────────────────────────────
async function handleCheckout(env: Env, cors: Record<string, string>): Promise<Response> {
  const stripe = makeStripe(env);
  const akey = generateAccountKey();
  const successUrl =
    env.SUCCESS_URL + (env.SUCCESS_URL.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}';
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      client_reference_id: akey,
      subscription_data: { metadata: { akey } },
      success_url: successUrl,
      cancel_url: env.CANCEL_URL,
    });
    // Record the account key up front as pending, so the app can poll straight away.
    await putRecord(env, akey, { status: 'pending' });
    return json({ url: session.url, accountKey: akey }, { status: 200 }, cors);
  } catch (err) {
    console.error(`[checkout] ${(err as Error).message}`);
    return json({ error: 'checkout_failed' }, { status: 502 }, cors);
  }
}

// ── POST /webhook ──────────────────────────────────────────────────────────
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });
  const rawBody = await request.text();
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

  if (await env.ENTITLEMENTS.get(evtKey(event.id))) {
    return new Response('ok (duplicate)', { status: 200 });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const akey = session.client_reference_id;
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const email = session.customer_details?.email ?? session.customer_email ?? undefined;
      // Only grant on a genuinely-paid checkout. For subscription mode with
      // SCA/async payments the session can complete with payment_status
      // 'unpaid'/'no_payment_required'; treat only 'paid' as active. If it isn't
      // paid yet, record the mapping as pending — the subsequent
      // customer.subscription.updated event flips it to the real status.
      if (akey && subId) {
        const paid = session.payment_status === 'paid';
        await putRecord(env, akey, {
          status: paid ? 'active' : 'pending',
          customerId,
          subscriptionId: subId,
          email,
        });
        await env.ENTITLEMENTS.put(subKey(subId), akey);
      }
    } else if (
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const sub = event.data.object as Stripe.Subscription;
      // Prefer the metadata akey; fall back to the sub->akey reverse index.
      const akey = sub.metadata?.['akey'] ?? (await env.ENTITLEMENTS.get(subKey(sub.id)));
      if (akey) {
        const existing = (await getRecord(env, akey)) ?? { status: 'pending' };
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
        await putRecord(env, akey, { ...existing, status, subscriptionId: sub.id });
      }
    }
  } catch (err) {
    console.error(`[webhook] handler error: ${(err as Error).message}`);
    // Fall through and mark processed — a poison event must not retry forever.
  }

  await env.ENTITLEMENTS.put(evtKey(event.id), '1', { expirationTtl: 60 * 60 * 24 * 30 });
  return new Response('ok', { status: 200 });
}

// ── POST /entitlement ────────────────────────────────────────────────────
async function handleEntitlement(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let akey: string | undefined;
  try {
    const body = (await request.json()) as { accountKey?: unknown };
    if (typeof body.accountKey === 'string') akey = body.accountKey;
  } catch {
    /* fall through to the missing-key error */
  }
  if (!akey) return json({ active: false, error: 'missing_account_key' }, { status: 400 }, cors);

  const record = await getRecord(env, akey);
  if (!record || !isActive(record.status)) {
    return json({ active: false, status: record?.status ?? 'unknown' }, { status: 200 }, cors);
  }

  const ttl = Number(env.ENTITLEMENT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  const iss = Math.floor(Date.now() / 1000);
  const exp = iss + ttl;
  const token = await signEntitlement(buildEntitlement({ akey, iss, exp }), env.LICENCE_SIGNING_KEY);
  return json({ active: true, token, exp }, { status: 200 }, cors);
}

// ── POST /portal ───────────────────────────────────────────────────────────
async function handlePortal(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let akey: string | undefined;
  try {
    const body = (await request.json()) as { accountKey?: unknown };
    if (typeof body.accountKey === 'string') akey = body.accountKey;
  } catch {
    /* fall through */
  }
  const record = akey ? await getRecord(env, akey) : null;
  if (!record?.customerId) {
    return json({ error: 'unknown_account' }, { status: 404 }, cors);
  }
  try {
    const stripe = makeStripe(env);
    const portal = await stripe.billingPortal.sessions.create({
      customer: record.customerId,
      return_url: env.PORTAL_RETURN_URL ?? env.SUCCESS_URL,
    });
    return json({ url: portal.url }, { status: 200 }, cors);
  } catch (err) {
    console.error(`[portal] ${(err as Error).message}`);
    return json({ error: 'portal_failed' }, { status: 502 }, cors);
  }
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'));

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/checkout' && request.method === 'POST') return handleCheckout(env, cors);
    if (url.pathname === '/webhook' && request.method === 'POST') return handleWebhook(request, env);
    if (url.pathname === '/entitlement' && request.method === 'POST')
      return handleEntitlement(request, env, cors);
    if (url.pathname === '/portal' && request.method === 'POST') return handlePortal(request, env, cors);
    if (url.pathname === '/success' && request.method === 'GET') return html(successPage());
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('affiliate-mcp entitlement issuer', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },
};

function successPage(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>subscription active</title>
<style>
  body { font-family:'JetBrains Mono',ui-monospace,Menlo,monospace; background:#fff; color:#0a0a0a;
         margin:0; padding:40px 20px; display:flex; justify-content:center; }
  .card { width:100%; max-width:640px; border:2px solid #0a0a0a; padding:28px; box-shadow:6px 6px 0 #0a0a0a; }
  h1 { font-size:22px; font-weight:700; margin:0 0 4px; text-transform:lowercase; }
  p { font-size:14px; line-height:1.55; }
  .muted { color:#555; font-size:12px; }
</style></head>
<body><div class="card">
  <h1>you're subscribed</h1>
  <p>Thanks for subscribing to affiliate-mcp premium. Return to the app — it will pick up your subscription automatically and unlock the premium skill packs.</p>
  <p class="muted">Manage or cancel any time from the app's account screen.</p>
</div></body></html>`;
}
