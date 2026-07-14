/**
 * H6 billing routes: session-gated Stripe Checkout creation, the webhook that
 * mirrors Stripe's subscription lifecycle into `HOSTED_BILLING`, and the
 * entitlement read the hosted MCP transport (`src/hosted-transport/`, root
 * workspace) consults on every tool call. Mirrors the entitlement-issuer
 * Worker's shape (`issuer/src/index.ts`) — see `src/billing.ts`'s file-header
 * comment for the one deliberate difference (a real authenticated userId
 * instead of an anonymous account key).
 */

import type { Env } from '../env.js';
import { json } from '../http.js';
import {
  type PaidHostedTier,
  getSubscriptionRecord,
  getUserIdForSubscription,
  isActiveStatus,
  putSubscriptionRecord,
  putSubscriptionReverseIndex,
  resolveEntitlement,
} from '../billing.js';
import { createCheckoutSession, verifyStripeSignature } from '../stripe.js';
// Full-scope only (H6, `./guard.ts`): a digest-scoped token has no business
// creating checkout sessions or reading billing state — its whole job is two
// vault reads. The webhook route carries no session at all (Stripe signs it).
import { requireFullSession } from './guard.js';

interface CheckoutBody {
  tier?: unknown;
}

function isPaidTierInput(value: unknown): value is PaidHostedTier {
  return value === 'solo' || value === 'pro';
}

function priceIdForTier(env: Env, tier: PaidHostedTier): string | undefined {
  return tier === 'solo' ? env.STRIPE_PRICE_ID_SOLO : env.STRIPE_PRICE_ID_PRO;
}

// ── POST /billing/checkout ───────────────────────────────────────────────
export async function handleBillingCheckout(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireFullSession(request, env, cors);
  if (auth instanceof Response) return auth;

  let body: CheckoutBody;
  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 }, cors);
  }
  if (!isPaidTierInput(body.tier)) {
    return json({ error: 'invalid_tier' }, { status: 400 }, cors);
  }

  if (!env.STRIPE_SECRET_KEY) {
    // Stripe is not wired up on this deploy yet (env placeholder, per the
    // workstream brief). Honest about WHY checkout cannot proceed, not a
    // generic 500 — matches Principle 4.1's "never collapse distinct
    // failures" even outside the adapter error envelope's own type.
    return json({ error: 'billing_not_configured' }, { status: 503 }, cors);
  }
  const priceId = priceIdForTier(env, body.tier);
  if (!priceId) {
    return json({ error: 'billing_not_configured', tier: body.tier }, { status: 503 }, cors);
  }
  if (!env.BILLING_SUCCESS_URL || !env.BILLING_CANCEL_URL) {
    return json({ error: 'billing_not_configured' }, { status: 503 }, cors);
  }

  try {
    const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
      priceId,
      clientReferenceId: auth.userId,
      successUrl: env.BILLING_SUCCESS_URL,
      cancelUrl: env.BILLING_CANCEL_URL,
      metadata: { userId: auth.userId, tier: body.tier },
      subscriptionMetadata: { userId: auth.userId, tier: body.tier },
    });
    return json({ url: session.url }, { status: 200 }, cors);
  } catch (err) {
    console.error(`[billing] checkout failed userId=${auth.userId} tier=${body.tier} message=${(err as Error).message}`);
    return json({ error: 'checkout_failed' }, { status: 502 }, cors);
  }
}

// ── POST /billing/webhook ────────────────────────────────────────────────
interface StripeCheckoutSessionObject {
  client_reference_id?: string | null;
  subscription?: string | null;
  customer?: string | null;
  customer_details?: { email?: string | null } | null;
  customer_email?: string | null;
  payment_status?: string;
  metadata?: Record<string, string> | null;
}

interface StripeSubscriptionObject {
  id: string;
  status: string;
  metadata?: Record<string, string> | null;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

export async function handleBillingWebhook(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'billing_not_configured' }, { status: 503 }, cors);
  }
  const sigHeader = request.headers.get('stripe-signature');
  if (!sigHeader) return json({ error: 'missing_signature' }, { status: 400 }, cors);

  const rawBody = await request.text();
  const validSignature = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!validSignature) return json({ error: 'invalid_signature' }, { status: 400 }, cors);

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 }, cors);
  }

  const eventKvKey = `evt:${event.id}`;
  if (await env.HOSTED_BILLING.get(eventKvKey)) {
    return json({ ok: true, duplicate: true }, { status: 200 }, cors);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as StripeCheckoutSessionObject;
      const userId = session.client_reference_id ?? session.metadata?.['userId'];
      const tier = session.metadata?.['tier'];
      const subscriptionId = session.subscription ?? undefined;
      const customerId = session.customer ?? undefined;
      const email = session.customer_details?.email ?? session.customer_email ?? undefined;
      if (userId && isPaidTierInput(tier) && subscriptionId) {
        const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
        await putSubscriptionRecord(env.HOSTED_BILLING, userId, {
          tier,
          status: paid ? 'active' : 'pending',
          ...(customerId ? { customerId } : {}),
          subscriptionId,
          ...(email ? { email } : {}),
          updatedAt: Math.floor(Date.now() / 1000),
        });
        await putSubscriptionReverseIndex(env.HOSTED_BILLING, subscriptionId, userId);
      } else {
        // A completed checkout this handler cannot attribute grants nothing —
        // that is correct (never guess a tier or user), but it must not be
        // silent: someone PAID and got no entitlement. A Checkout Session
        // created outside `handleBillingCheckout` (a hand-built payment link,
        // a misconfigured dashboard product) arrives without our metadata and
        // lands here. Log the structured reason (event id and which fields
        // were missing; never the email or any customer detail) so it is
        // diagnosable from the Worker's logs.
        console.error(
          `[billing] webhook checkout.session.completed ignored eventId=${event.id} ` +
            `hasUserId=${Boolean(userId)} tierValid=${isPaidTierInput(tier)} hasSubscriptionId=${Boolean(subscriptionId)}`,
        );
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as StripeSubscriptionObject;
      const tier = sub.metadata?.['tier'];
      const userId =
        sub.metadata?.['userId'] ?? (await getUserIdForSubscription(env.HOSTED_BILLING, sub.id));
      if (userId && isPaidTierInput(tier)) {
        const existing = await getSubscriptionRecord(env.HOSTED_BILLING, userId);
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
        await putSubscriptionRecord(env.HOSTED_BILLING, userId, {
          ...(existing ?? { tier }),
          tier,
          status,
          subscriptionId: sub.id,
          updatedAt: Math.floor(Date.now() / 1000),
        });
      }
    }
  } catch (err) {
    // Fall through and mark the event processed regardless — a poison event
    // must not retry forever, matching the issuer Worker's own webhook
    // handler (`issuer/src/index.ts`).
    console.error(`[billing] webhook handler error type=${event.type} message=${(err as Error).message}`);
  }

  await env.HOSTED_BILLING.put(eventKvKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true }, { status: 200 }, cors);
}

// ── GET /billing/entitlement ──────────────────────────────────────────────
// Session-gated: the ONE billing route the hosted MCP transport calls, with
// the caller's own session bearer token — the same reuse-caller's-own-token
// pattern H4's vault-client already established, never a service credential.
export async function handleBillingEntitlement(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const auth = await requireFullSession(request, env, cors);
  if (auth instanceof Response) return auth;

  const entitlement = await resolveEntitlement(env.HOSTED_BILLING, auth.userId);
  return json(entitlement, { status: 200 }, cors);
}

export { isActiveStatus };
