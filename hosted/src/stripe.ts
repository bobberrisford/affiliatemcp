/**
 * Minimal Stripe REST client: raw `fetch` to the Checkout Sessions API, plus a
 * hand-rolled webhook signature verifier over WebCrypto HMAC-SHA256.
 *
 * Why not the `stripe` npm package (unlike `issuer/`, which already depends
 * on it): this build's rules are "no new deps", and everything else in
 * `hosted/` is deliberately WebCrypto-and-`fetch`-only — see `src/token.ts`
 * and `src/vault.ts`'s file-header comments, both of which call out "no
 * third-party crypto dependency" as a design choice, not an oversight. Stripe
 * Checkout Session creation is one `POST` with form-encoded params, and
 * webhook verification is Stripe's own documented, simple scheme (HMAC-SHA256
 * over `"{timestamp}.{payload}"`, compared to the `v1` value(s) in the
 * `Stripe-Signature` header, with a timestamp-tolerance replay check) — both
 * are a small, bounded amount of code, so hand-rolling them keeps this
 * dependency-free rather than adding the SDK for two calls. A third call,
 * `POST /v1/billing_portal/sessions` (`createBillingPortalSession` below),
 * followed the same shape closely enough (one more form-encoded POST) that it
 * did not change this trade-off; revisit if hosted's Stripe surface grows
 * again beyond checkout, webhook, and portal (for example, proration
 * previews).
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches issuer/src/index.ts, for one consistent
// Stripe API surface across both Workers.
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface CreateCheckoutSessionParams {
  priceId: string;
  clientReferenceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  subscriptionMetadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

/** Form-encode Stripe's bracketed nested-parameter convention, e.g.
 * `encodeForm({ metadata: { userId: 'x' } })` -> `metadata[userId]=x`. */
function appendFormEntries(params: URLSearchParams, prefix: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      appendFormEntries(params, `${prefix}[${key}]`, nested);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormEntries(params, `${prefix}[${index}]`, item));
    return;
  }
  params.append(prefix, String(value));
}

function stripeHeaders(secretKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${secretKey}`,
    'content-type': 'application/x-www-form-urlencoded',
    'stripe-version': STRIPE_API_VERSION,
  };
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

/**
 * Create a Stripe subscription Checkout Session for one price, with the
 * caller-supplied client-reference-id and metadata carried onto both the
 * Session and (via `subscription_data.metadata`) the resulting Subscription —
 * see `routes/billing.ts` for why both matter (the webhook's
 * `checkout.session.completed` event reads the Session's own metadata;
 * `customer.subscription.updated`/`.deleted` events only ever see the
 * Subscription's).
 */
export async function createCheckoutSession(
  secretKey: string,
  params: CreateCheckoutSessionParams,
): Promise<StripeCheckoutSession> {
  const body = new URLSearchParams();
  appendFormEntries(body, 'mode', 'subscription');
  appendFormEntries(body, 'line_items', [{ price: params.priceId, quantity: 1 }]);
  appendFormEntries(body, 'client_reference_id', params.clientReferenceId);
  appendFormEntries(body, 'success_url', params.successUrl);
  appendFormEntries(body, 'cancel_url', params.cancelUrl);
  appendFormEntries(body, 'automatic_tax', { enabled: true });
  appendFormEntries(body, 'billing_address_collection', 'required');
  appendFormEntries(body, 'metadata', params.metadata);
  appendFormEntries(body, 'subscription_data', { metadata: params.subscriptionMetadata });

  const res = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: stripeHeaders(secretKey),
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new StripeApiError(`Stripe checkout session create failed: HTTP ${res.status} ${text}`, res.status);
  }
  const json = (await res.json()) as { id: string; url: string | null };
  return { id: json.id, url: json.url };
}

export interface CreateBillingPortalSessionParams {
  customerId: string;
  returnUrl: string;
}

export interface StripeBillingPortalSession {
  url: string;
}

/**
 * Create a Stripe Billing Portal session for one customer, mirroring the
 * entitlement-issuer Worker's `handlePortal` (`issuer/src/index.ts`,
 * `stripe.billingPortal.sessions.create`) but as a hand-rolled REST call, for
 * the same "no new deps" reason `createCheckoutSession` above is. The portal
 * itself is where a subscriber cancels, changes payment method, or (if
 * enabled in the Stripe dashboard) switches plans; this Worker only mints the
 * one-time session URL and never sees what happens inside it.
 */
export async function createBillingPortalSession(
  secretKey: string,
  params: CreateBillingPortalSessionParams,
): Promise<StripeBillingPortalSession> {
  const body = new URLSearchParams();
  appendFormEntries(body, 'customer', params.customerId);
  appendFormEntries(body, 'return_url', params.returnUrl);

  const res = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: 'POST',
    headers: stripeHeaders(secretKey),
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new StripeApiError(`Stripe billing portal session create failed: HTTP ${res.status} ${text}`, res.status);
  }
  const json = (await res.json()) as { url: string };
  return { url: json.url };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/** Constant-time comparison of two equal-length hex strings, so signature comparison does not
 * leak timing information about how many leading bytes matched. */
function timingSafeHexEqual(a: string, b: string): boolean {
  const aBytes = hexToBytes(a);
  const bBytes = hexToBytes(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
  return diff === 0;
}

/**
 * Verify a Stripe `Stripe-Signature` header against the raw webhook body,
 * per Stripe's documented scheme: the header is a comma-separated list of
 * `t=<unixSeconds>` and one or more `v1=<hex>` values; the expected signature
 * is `HMAC-SHA256(webhookSecret, "{t}.{payload}")`. Returns `true` only when
 * at least one `v1` value matches AND `t` is within
 * `SIGNATURE_TOLERANCE_SECONDS` of now, guarding against a replayed old
 * event with a once-valid signature.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  webhookSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = signatureHeader.split(',').map((p) => p.trim());
  let timestamp: number | undefined;
  const v1Signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value) timestamp = Number(value);
    else if (key === 'v1' && value) v1Signatures.push(value);
  }
  if (timestamp === undefined || v1Signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = await hmacSha256Hex(webhookSecret, `${timestamp}.${payload}`);
  return v1Signatures.some((sig) => sig.length === expected.length && timingSafeHexEqual(sig, expected));
}

/** Builds a valid `Stripe-Signature` header value for a given payload — the inverse of
 * `verifyStripeSignature`. Exported for tests only (this Worker never signs its own webhook
 * calls in production; Stripe does), so a test can construct a payload Stripe itself would have
 * produced without a live Stripe account. */
export async function signStripePayloadForTest(
  payload: string,
  webhookSecret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const sig = await hmacSha256Hex(webhookSecret, `${timestamp}.${payload}`);
  return `t=${timestamp},v1=${sig}`;
}
