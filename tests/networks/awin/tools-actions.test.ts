/**
 * Awin publisher programme-application tool + action-map wiring tests.
 *
 * Covers: the one browser/write descriptor surfaces through
 * collectActionDescriptors and filters correctly; the propose tool exists, has a
 * strict schema, is readOnlyHint, records a handoff_emitted audit line (never
 * applied/succeeded) and returns the gap; the report tool closes the arc with
 * verified/verify_failed. Unlike the advertiser side, applying does NOT require
 * a brand binding: `brand` is a free display label, because publishers apply
 * to brands they have not joined.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Importing the networks aggregator registers every real adapter, including
// the awin publisher adapter, so collectActionDescriptors sees it.
import '../../../src/networks/index.js';

import * as auditModule from '../../../src/shared/audit.js';
import { collectActionDescriptors } from '../../../src/tools/action-map.js';
import { generateAwinTools } from '../../../src/networks/awin/tools.js';

function proposeTool() {
  const tool = generateAwinTools().find((t) => t.name === 'affiliate_awin_propose_application');
  if (!tool) throw new Error('propose tool missing');
  return tool;
}

function reportTool() {
  const tool = generateAwinTools().find(
    (t) => t.name === 'affiliate_awin_report_application_result',
  );
  if (!tool) throw new Error('report tool missing');
  return tool;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Awin publisher action-map wiring', () => {
  it('surfaces the single awin.applyToProgramme browser/write descriptor', () => {
    const descriptors = collectActionDescriptors().filter((d) => d.network === 'awin');
    expect(descriptors.map((d) => d.id)).toEqual(['awin.applyToProgramme']);
    const d = descriptors[0]!;
    expect(d.channel).toBe('browser');
    expect(d.effect).toBe('write');
    expect(d.defaultAuthorityTier).toBe(3);
  });
});

describe('affiliate_awin_propose_application tool', () => {
  it('is readOnlyHint with a strict schema requiring brand, advertiserId, programmeName', () => {
    const tool = proposeTool();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const schema = tool.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['brand', 'advertiserId', 'programmeName']),
    );
    expect(schema.additionalProperties).toBe(false);
  });

  it('rejects an unknown key such as a smuggled startingUrl', async () => {
    const tool = proposeTool();
    await expect(
      (async () =>
        tool.handle({
          brand: 'example-brand',
          advertiserId: 1234,
          programmeName: 'Example Brand',
          startingUrl: 'https://evil.example/phish',
        }))(),
    ).rejects.toThrow();
  });

  it('rejects blank or non-numeric advertiser ids before emitting a handoff', async () => {
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const tool = proposeTool();

    for (const advertiserId of ['', '   ', 'https://evil.example/phish']) {
      await expect(
        (async () =>
          tool.handle({
            brand: 'example-brand',
            advertiserId,
            programmeName: 'Example Brand',
          }))(),
      ).rejects.toThrow();
    }

    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('records a handoff_emitted audit line and never applied/succeeded, then returns the gap', async () => {
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const result = (await proposeTool().handle({
      brand: 'example-brand',
      advertiserId: 1234,
      programmeName: 'Example Brand',
      promotionMethodSummary: 'content site',
    })) as { kind: string; browserFallback: { mutates: boolean } | null };

    expect(result.kind).toBe('api-gap');
    expect(result.browserFallback).not.toBeNull();

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const entry = auditSpy.mock.calls[0]?.[0];
    expect(entry?.event).toBe('handoff_emitted');
    expect(entry?.action).toBe('awin.applyToProgramme');
    expect(entry?.network).toBe('awin');
    expect(['write_dispatched', 'write_verified', 'verified']).not.toContain(entry?.event);
    expect(entry?.intendedAfterState).toBeDefined();
    expect(typeof entry?.occurredAt).toBe('string');
  });

  it('counts the emitted handoff as mutating for the per-day consent basis', async () => {
    const captured: auditModule.ActionAuditEntry[] = [];
    vi.spyOn(auditModule, 'recordActionAudit').mockImplementation((entry) => {
      captured.push(entry);
    });
    await proposeTool().handle({
      brand: 'example-brand',
      advertiserId: 1234,
      programmeName: 'Example Brand',
    });
    const day = captured[0]?.occurredAt?.slice(0, 10) ?? '1970-01-01';
    expect(auditModule.countMutatingHandoffsOn(captured, day)).toBe(1);
  });

  it('does not require a brand binding (free label): succeeds for an unbound brand', async () => {
    vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const result = (await proposeTool().handle({
      brand: 'never-bound-brand',
      advertiserId: 9999,
      programmeName: 'Some New Brand',
    })) as { kind: string };
    expect(result.kind).toBe('api-gap');
  });
});

describe('affiliate_awin_report_application_result tool', () => {
  it('is readOnlyHint with a strict schema that rejects unknown keys', async () => {
    const tool = reportTool();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const schema = tool.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['brand', 'advertiserId', 'programmeName', 'verified']),
    );
    expect(schema.additionalProperties).toBe(false);

    await expect(
      (async () =>
        tool.handle({
          brand: 'example-brand',
          advertiserId: 1234,
          programmeName: 'Example Brand',
          verified: true,
          unexpected: 'nope',
        }))(),
    ).rejects.toThrow();
  });

  it('records verified when verified=true and never applied/succeeded', async () => {
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const result = (await reportTool().handle({
      brand: 'example-brand',
      advertiserId: 1234,
      programmeName: 'Example Brand',
      verified: true,
      note: 'relationship reads pending',
    })) as { recorded: string };

    expect(result.recorded).toBe('verified');
    const entry = auditSpy.mock.calls[0]?.[0];
    expect(entry?.event).toBe('verified');
    expect(entry?.action).toBe('awin.applyToProgramme');
    expect(entry?.network).toBe('awin');
    expect(['write_dispatched', 'write_verified', 'handoff_emitted']).not.toContain(entry?.event);
  });

  it('records verify_failed when verified=false', async () => {
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const result = (await reportTool().handle({
      brand: 'example-brand',
      advertiserId: 1234,
      programmeName: 'Example Brand',
      verified: false,
    })) as { recorded: string };

    expect(result.recorded).toBe('verify_failed');
    const entry = auditSpy.mock.calls[0]?.[0];
    expect(entry?.event).toBe('verify_failed');
    expect(entry?.action).toBe('awin.applyToProgramme');
  });

  it('rejects blank or non-numeric advertiser ids before recording a result', async () => {
    const auditSpy = vi.spyOn(auditModule, 'recordActionAudit').mockImplementation(() => {});
    const tool = reportTool();

    for (const advertiserId of ['', '   ', 'https://evil.example/phish']) {
      await expect(
        (async () =>
          tool.handle({
            brand: 'example-brand',
            advertiserId,
            programmeName: 'Example Brand',
            verified: true,
          }))(),
      ).rejects.toThrow();
    }

    expect(auditSpy).not.toHaveBeenCalled();
  });
});
