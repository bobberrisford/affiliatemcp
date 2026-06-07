/**
 * Webhook signature verification, exercised the same way the Worker does it:
 * constructEventAsync + the SubtleCrypto provider. A correctly-signed event is
 * accepted; a bad signature is rejected. Fixtures use Stripe's own
 * generateTestHeaderString helper.
 */

import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';

function makeStripe(): Stripe {
  // No network calls happen for webhook construction; key is irrelevant here.
  return new Stripe('sk_test_dummy', {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
  });
}

function sampleEventPayload(): string {
  return JSON.stringify({
    id: 'evt_test_123',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        object: 'checkout.session',
        customer_details: { email: 'buyer@acme.com' },
      },
    },
  });
}

describe('Stripe webhook signature verification', () => {
  it('accepts a correctly-signed event', async () => {
    const stripe = makeStripe();
    const payload = sampleEventPayload();
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const event = await stripe.webhooks.constructEventAsync(
      payload,
      header,
      WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );

    expect(event.id).toBe('evt_test_123');
    expect(event.type).toBe('checkout.session.completed');
  });

  it('rejects a bad signature', async () => {
    const stripe = makeStripe();
    const payload = sampleEventPayload();
    const badHeader = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_the_wrong_secret',
    });

    await expect(
      stripe.webhooks.constructEventAsync(
        payload,
        badHeader,
        WEBHOOK_SECRET,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      ),
    ).rejects.toThrow();
  });
});
