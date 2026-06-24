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
  it('exposes the propose and report tools, readOnlyHint, strict schema', () => {
    const tools = generateAwinAdvertiserTools();
    expect(tools.map((t) => t.name)).toEqual([
      'affiliate_awin-advertiser_propose_publisher_decision',
      'affiliate_awin-advertiser_report_publisher_decision_result',
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
    })) as {
      kind: string;
      browserFallback: { mutates: boolean; startingUrl: string } | null;
    };

    expect(result.kind).toBe('api-gap');
    expect(result.browserFallback).not.toBeNull();
    // advertiserId is derived from the resolved brand binding (adv-99), not from
    // tool input, and scopes the partnerships-page startingUrl.
    expect(result.browserFallback?.startingUrl).toBe(
      'https://app.awin.com/en/awin/advertiser/adv-99/partnerships/all',
    );

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

describe('Awin advertiser report_publisher_decision_result tool', () => {
  function reportTool() {
    const tool = generateAwinAdvertiserTools()[1];
    if (!tool) throw new Error('report tool missing');
    return tool;
  }

  function bindAcme() {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'awin-advertiser', credentialId: 'default', networkBrandId: 'adv-99' }],
      },
    });
  }

  it('is readOnlyHint with a strict schema that rejects unknown keys', async () => {
    const tool = reportTool();
    expect(tool.name).toBe('affiliate_awin-advertiser_report_publisher_decision_result');
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const schema = tool.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['brand', 'programmeId', 'publisherId', 'decision', 'verified']),
    );
    expect(schema.additionalProperties).toBe(false);

    bindAcme();
    await expect(
      (async () =>
        tool.handle({
          brand: 'acme',
          programmeId: 'prog-1',
          publisherId: '12345',
          decision: 'approve',
          verified: true,
          unexpected: 'nope',
        }))(),
    ).rejects.toThrow();
  });

  it('records verified when verified=true and never applied/succeeded', async () => {
    bindAcme();
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const result = (await reportTool().handle({
      brand: 'acme',
      programmeId: 'prog-1',
      publisherId: '12345',
      decision: 'approve',
      verified: true,
      note: 'row gone from pending queue',
    })) as { recorded: string };

    expect(result.recorded).toBe('verified');
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const entry = auditSpy.mock.calls[0]?.[0];
    expect(entry?.event).toBe('verified');
    expect(entry?.action).toBe('awin-advertiser.approvePublisher');
    expect(entry?.network).toBe('awin-advertiser');
    expect(typeof entry?.occurredAt).toBe('string');
    // Never an applied/succeeded-style event.
    expect(['write_dispatched', 'write_verified', 'handoff_emitted']).not.toContain(entry?.event);
  });

  it('records verify_failed when verified=false, using the decline descriptor id', async () => {
    bindAcme();
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const result = (await reportTool().handle({
      brand: 'acme',
      programmeId: 'prog-1',
      publisherId: '67890',
      decision: 'decline',
      verified: false,
    })) as { recorded: string };

    expect(result.recorded).toBe('verify_failed');
    const entry = auditSpy.mock.calls[0]?.[0];
    expect(entry?.event).toBe('verify_failed');
    expect(entry?.action).toBe('awin-advertiser.declinePublisher');
  });

  it('surfaces BrandNotRegistered when the brand is not bound', async () => {
    await expect(
      (async () =>
        reportTool().handle({
          brand: 'never-bound',
          programmeId: 'prog-1',
          publisherId: '12345',
          decision: 'approve',
          verified: true,
        }))(),
    ).rejects.toBeInstanceOf(BrandNotRegistered);
  });
});
