/**
 * Awin advertiser publisher-decision tool + action-map wiring tests.
 *
 * Covers: the two write/browser descriptors surface through
 * collectActionDescriptors and filter correctly; readiness is fail-closed; the
 * propose tool exists, has a strict schema, is readOnlyHint, and records a
 * handoff_emitted audit line (never applied/succeeded) when called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Importing the networks aggregator registers every real adapter, including
// awin-advertiser, so collectActionDescriptors sees it.
import '../../../src/networks/index.js';

import * as auditModule from '../../../src/shared/audit.js';
import { collectActionDescriptors } from '../../../src/tools/action-map.js';
import { computeReadiness, snapshotCredentials } from '../../../src/shared/action-map.js';
import { saveBrands } from '../../../src/shared/brands.js';
import { generateAwinAdvertiserTools } from '../../../src/networks/awin-advertiser/tools.js';
import { BrandNotRegistered } from '../../../src/shared/errors.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalToken: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-awin-adv-tools-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  originalToken = process.env['AWIN_ADVERTISER_API_TOKEN'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  delete process.env['AWIN_ADVERTISER_API_TOKEN'];
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  if (originalToken === undefined) delete process.env['AWIN_ADVERTISER_API_TOKEN'];
  else process.env['AWIN_ADVERTISER_API_TOKEN'] = originalToken;
  vi.restoreAllMocks();
});

describe('Awin advertiser action-map wiring', () => {
  it('surfaces the two awin-advertiser browser/write descriptors', () => {
    const descriptors = collectActionDescriptors().filter((d) => d.network === 'awin-advertiser');
    expect(descriptors.map((d) => d.id).sort()).toEqual([
      'awin-advertiser.approvePublisher',
      'awin-advertiser.declinePublisher',
    ]);
    for (const d of descriptors) {
      expect(d.channel).toBe('browser');
      expect(d.effect).toBe('write');
      expect(d.defaultAuthorityTier).toBe(3);
    }
  });

  it('filtering by effect write and channel browser returns both entries', () => {
    const all = collectActionDescriptors();
    const writes = all.filter((d) => d.network === 'awin-advertiser' && d.effect === 'write');
    const browsers = all.filter((d) => d.network === 'awin-advertiser' && d.channel === 'browser');
    expect(writes).toHaveLength(2);
    expect(browsers).toHaveLength(2);
  });

  it('readiness is fail-closed: unknown with no brand, missing_credentials when token absent', () => {
    const descriptor = collectActionDescriptors().find(
      (d) => d.id === 'awin-advertiser.approvePublisher',
    );
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error('approvePublisher descriptor missing');

    const credentials = snapshotCredentials(descriptor);
    // No brand named at all -> cannot be confirmed ready.
    expect(computeReadiness(credentials, { brandProvided: false, brandBoundToNetwork: false })).toBe(
      'unknown',
    );
    // Brand bound but the AWIN_ADVERTISER_API_TOKEN is not configured.
    expect(
      computeReadiness(credentials, { brandProvided: true, brandBoundToNetwork: true }),
    ).toBe('missing_credentials');
  });
});

describe('Awin advertiser propose_publisher_decision tool', () => {
  it('exposes exactly the one propose tool, readOnlyHint, strict schema', () => {
    const tools = generateAwinAdvertiserTools();
    expect(tools.map((t) => t.name)).toEqual([
      'affiliate_awin-advertiser_propose_publisher_decision',
    ]);
    const tool = tools[0];
    if (!tool) throw new Error('tool missing');
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['brand', 'programmeId', 'publisherId', 'publisherName', 'decision']),
    );
    // .strict() => no unknown keys allowed.
    expect(schema.additionalProperties).toBe(false);
  });

  it('rejects an unknown key such as a smuggled startingUrl', async () => {
    const tool = generateAwinAdvertiserTools()[0];
    if (!tool) throw new Error('tool missing');
    // The handler validates synchronously before the async boundary, so wrap
    // the call to capture either a synchronous throw or a rejected promise.
    await expect(
      (async () =>
        tool.handle({
          brand: 'acme',
          programmeId: 'prog-1',
          publisherId: '12345',
          publisherName: 'Cashback Co',
          decision: 'approve',
          startingUrl: 'https://evil.example/phish',
        }))(),
    ).rejects.toThrow();
  });

  it('records a handoff_emitted audit line and never applied/succeeded, then returns the gap', async () => {
    // Bind the brand so the brand-binding check passes.
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'awin-advertiser', credentialId: 'default', networkBrandId: 'adv-99' },
        ],
      },
    });

    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const tool = generateAwinAdvertiserTools()[0];
    if (!tool) throw new Error('tool missing');

    const result = (await tool.handle({
      brand: 'acme',
      programmeId: 'prog-1',
      publisherId: '12345',
      publisherName: 'Cashback Co',
      decision: 'approve',
    })) as { kind: string; browserFallback: { mutates: boolean } | null };

    expect(result.kind).toBe('api-gap');
    expect(result.browserFallback).not.toBeNull();

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const entry = auditSpy.mock.calls[0]?.[0];
    expect(entry?.event).toBe('handoff_emitted');
    expect(entry?.action).toBe('awin-advertiser.approvePublisher');
    expect(entry?.network).toBe('awin-advertiser');
    // Never an applied/succeeded-style event.
    expect(['write_dispatched', 'write_verified', 'verified']).not.toContain(entry?.event);
    // intendedAfterState present so the entry counts as a mutating handoff.
    expect(entry?.intendedAfterState).toBeDefined();
    expect(typeof entry?.occurredAt).toBe('string');
  });

  it('counts the emitted handoff as mutating for the per-day consent basis', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'awin-advertiser', credentialId: 'default', networkBrandId: 'adv-99' },
        ],
      },
    });
    const captured: auditModule.ActionAuditEntry[] = [];
    vi.spyOn(auditModule, 'recordActionAudit').mockImplementation((entry) => {
      captured.push(entry);
    });
    const tool = generateAwinAdvertiserTools()[0];
    if (!tool) throw new Error('tool missing');
    await tool.handle({
      brand: 'acme',
      programmeId: 'prog-1',
      publisherId: '12345',
      publisherName: 'Cashback Co',
      decision: 'decline',
      declineReason: 'out of category',
    });
    const day = captured[0]?.occurredAt?.slice(0, 10) ?? '1970-01-01';
    expect(auditModule.countMutatingHandoffsOn(captured, day)).toBe(1);
  });

  it('surfaces BrandNotRegistered when the brand is not bound', async () => {
    const tool = generateAwinAdvertiserTools()[0];
    if (!tool) throw new Error('tool missing');
    await expect(
      (async () =>
        tool.handle({
          brand: 'never-bound',
          programmeId: 'prog-1',
          publisherId: '12345',
          publisherName: 'Cashback Co',
          decision: 'approve',
        }))(),
    ).rejects.toBeInstanceOf(BrandNotRegistered);
  });
});
