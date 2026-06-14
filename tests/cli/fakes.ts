/**
 * Test fakes for the wizard / diagnostic CLIs.
 *
 * - `FakePrompter` answers queued responses in order so tests can script the
 *   wizard end-to-end without going near readline.
 * - `makeFakeAdapter` builds a `NetworkAdapter` whose `setupSteps`,
 *   `validateCredential`, `verifyAuth`, and `capabilitiesCheck` are spies
 *   we can assert on.
 */

import type {
  CredentialValidationResult,
  NetworkAdapter,
  NetworkCapabilities,
  NetworkMeta,
  ResilienceConfigMap,
  SetupStep,
} from '../../src/shared/types.js';
import type { Prompter } from '../../src/cli/wizard/prompts.js';

export class FakePrompter implements Prompter {
  private queue: unknown[];
  public stdout: string[] = [];
  constructor(answers: unknown[] = []) {
    this.queue = [...answers];
  }
  enqueue(...answers: unknown[]): void {
    this.queue.push(...answers);
  }
  private next<T>(kind: string): T {
    if (this.queue.length === 0) {
      throw new Error(`FakePrompter exhausted while answering ${kind}`);
    }
    return this.queue.shift() as T;
  }
  async text(_label: string): Promise<string> {
    return this.next<string>('text');
  }
  async password(_label: string): Promise<string> {
    return this.next<string>('password');
  }
  async number(_label: string): Promise<number> {
    return this.next<number>('number');
  }
  async menu<K extends string>(_label: string, _choices: Array<{ key: K; label: string }>): Promise<K> {
    return this.next<K>('menu');
  }
  async selectMany<K extends string>(
    _label: string,
    _choices: Array<{ key: K; label: string }>,
  ): Promise<K[]> {
    return this.next<K[]>('selectMany');
  }
  async confirm(_label: string): Promise<boolean> {
    return this.next<boolean>('confirm');
  }
}

export interface FakeAdapterOpts {
  slug: string;
  name: string;
  steps: SetupStep[];
  /** Overrides for the methods the wizard uses. */
  verifyAuth?: () => Promise<unknown>;
  capabilities?: () => Promise<NetworkCapabilities>;
  setupTimeEstimateMinutes?: number;
  setupRequiresApproval?: boolean;
  /** Which side of the relationship this adapter integrates with. Defaults to publisher. */
  side?: 'publisher' | 'advertiser';
  /** Credential scope. Defaults to single-brand. */
  credentialScope?: 'single-brand' | 'multi-brand';
}

export function makeFakeAdapter(opts: FakeAdapterOpts): NetworkAdapter {
  const meta: NetworkMeta = {
    slug: opts.slug,
    name: opts.name,
    baseUrl: `https://api.${opts.slug}.example`,
    authModel: 'bearer',
    adapterVersion: '0.0.0-fake',
    claimStatus: 'experimental',
    knownLimitations: [],
    supportsBrandOps: false,
    setupTimeEstimateMinutes: opts.setupTimeEstimateMinutes ?? 5,
    setupRequiresApproval: opts.setupRequiresApproval ?? false,
    side: opts.side ?? 'publisher',
    credentialScope: opts.credentialScope ?? 'single-brand',
  };
  const resilience: ResilienceConfigMap = {
    default: {
      timeoutMs: 1000,
      retries: 0,
      retryOn: [],
      circuitBreaker: { threshold: 1, cooldownMs: 1 },
    },
  };
  const notImplemented = async (): Promise<never> => {
    throw new Error('not implemented in fake');
  };
  return {
    slug: opts.slug,
    name: opts.name,
    meta,
    resilienceConfig: resilience,
    listProgrammes: notImplemented,
    getProgramme: notImplemented,
    listTransactions: notImplemented,
    getEarningsSummary: notImplemented,
    listClicks: notImplemented,
    generateTrackingLink: notImplemented,
    async verifyAuth() {
      if (opts.verifyAuth) return (await opts.verifyAuth()) as { ok: true } | { ok: false; reason: string };
      return { ok: true };
    },
    listPublishers: notImplemented,
    listPublisherSectors: notImplemented,
    async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
      const step = opts.steps.find((s) => s.field === field);
      if (step?.validateOnEntry) return step.validateOnEntry(value);
      return { ok: true };
    },
    setupSteps() {
      return opts.steps;
    },
    async capabilitiesCheck(): Promise<NetworkCapabilities> {
      if (opts.capabilities) return opts.capabilities();
      return {
        network: opts.slug,
        generatedAt: new Date().toISOString(),
        operations: {},
        knownLimitations: [],
      };
    },
  };
}
