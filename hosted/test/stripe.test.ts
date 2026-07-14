/**
 * Unit tests for the hand-rolled Stripe REST client (`src/stripe.ts`):
 * webhook signature verification (the security-relevant half) and the
 * Checkout Session creation call, with `fetch` mocked (no live Stripe
 * account, matching every other Worker test in this repo).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCheckoutSession, signStripePayloadForTest, verifyStripeSignature } from '../src/stripe.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a signature produced with the matching secret and a fresh timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayloadForTest(payload, secret, now);
    expect(await verifyStripeSignature(payload, header, secret, now)).toBe(true);
  });

  it('rejects a signature produced with a different secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayloadForTest(payload, 'whsec_other', now);
    expect(await verifyStripeSignature(payload, header, secret, now)).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayloadForTest(payload, secret, now);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted' });
    expect(await verifyStripeSignature(tampered, header, secret, now)).toBe(false);
  });

  it('rejects a signature whose timestamp is outside the tolerance window (replay guard)', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 60; // one hour ago
    const header = await signStripePayloadForTest(payload, secret, old);
    expect(await verifyStripeSignature(payload, header, secret, Math.floor(Date.now() / 1000))).toBe(false);
  });

  it('rejects a header with no recognisable t= or v1= fields', async () => {
    expect(await verifyStripeSignature(payload, 'garbage', secret)).toBe(false);
  });
});

describe('createCheckoutSession', () => {
  it('posts form-encoded params to Stripe and returns the session url', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' }), {
        status: 200,
      }),
    );

    const session = await createCheckoutSession('sk_test_x', {
      priceId: 'price_solo',
      clientReferenceId: 'hosted_usr_1',
      successUrl: 'https://agenticaffiliate.ai/success',
      cancelUrl: 'https://agenticaffiliate.ai/cancel',
      metadata: { userId: 'hosted_usr_1', tier: 'solo' },
      subscriptionMetadata: { userId: 'hosted_usr_1', tier: 'solo' },
    });

    expect(session).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk_test_x');
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get('client_reference_id')).toBe('hosted_usr_1');
    expect(sentBody.get('line_items[0][price]')).toBe('price_solo');
    expect(sentBody.get('subscription_data[metadata][tier]')).toBe('solo');
  });

  it('throws a StripeApiError on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 402 }));
    await expect(
      createCheckoutSession('sk_test_x', {
        priceId: 'price_solo',
        clientReferenceId: 'hosted_usr_1',
        successUrl: 'https://agenticaffiliate.ai/success',
        cancelUrl: 'https://agenticaffiliate.ai/cancel',
        metadata: {},
        subscriptionMetadata: {},
      }),
    ).rejects.toThrow(/HTTP 402/);
  });
});
