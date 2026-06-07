/**
 * POST /checkout returns a { url }. The Stripe SDK is mocked so no network
 * call happens — we assert the Worker wires the session URL through and that
 * the create call uses Checkout Sessions with the £39 inline price + Stripe Tax.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the stripe module. The default export is a constructor; instances expose
// checkout.sessions.create and the static helpers the Worker references.
const createMock = vi.fn(
  async (_params: Record<string, any>) => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }),
);

vi.mock('stripe', () => {
  class FakeStripe {
    checkout = { sessions: { create: createMock, retrieve: vi.fn() } };
    webhooks = {};
    static createFetchHttpClient() {
      return {};
    }
    static createSubtleCryptoProvider() {
      return {};
    }
    constructor(_key: string, _opts: unknown) {}
  }
  return { default: FakeStripe };
});

// Import AFTER the mock is registered.
const worker = (await import('../src/index.js')).default;
import type { Env } from '../src/env.js';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LICENCES: {} as KVNamespace,
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    LICENCE_SIGNING_KEY: 'dummy',
    LICENCE_FROM_EMAIL: 'licences@example.com',
    SUCCESS_URL: 'https://issuer.example.com/success',
    CANCEL_URL: 'https://issuer.example.com/cancel',
    ...overrides,
  } as Env;
}

describe('POST /checkout', () => {
  beforeEach(() => {
    createMock.mockClear();
  });

  it('returns the Stripe Checkout Session url', async () => {
    const res = await worker.fetch(
      new Request('https://issuer.example.com/checkout', { method: 'POST' }),
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
  });

  it('uses inline £39 GBP price_data with Stripe Tax and address collection', async () => {
    await worker.fetch(
      new Request('https://issuer.example.com/checkout', { method: 'POST' }),
      fakeEnv(),
    );
    expect(createMock).toHaveBeenCalledTimes(1);
    const params = createMock.mock.calls[0]![0];
    expect(params.mode).toBe('payment');
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe('required');
    expect(params.line_items[0].price_data.currency).toBe('gbp');
    expect(params.line_items[0].price_data.unit_amount).toBe(3900);
    expect(params.success_url).toContain('session_id={CHECKOUT_SESSION_ID}');
  });

  it('uses a pre-created Price id when STRIPE_PRICE_ID is set', async () => {
    await worker.fetch(
      new Request('https://issuer.example.com/checkout', { method: 'POST' }),
      fakeEnv({ STRIPE_PRICE_ID: 'price_live_xyz' }),
    );
    const params = createMock.mock.calls[0]![0];
    expect(params.line_items[0].price).toBe('price_live_xyz');
    expect(params.line_items[0].price_data).toBeUndefined();
  });
});
