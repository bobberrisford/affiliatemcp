/**
 * Tests for `src/shared/consent.ts`.
 *
 * Covers:
 *   - path resolution honouring AFFILIATE_MCP_CONFIG_DIR
 *   - load/save round-trip, missing-file default, malformed + wrong-shape throws
 *   - assertAuthorised: no grant → prompt; standing within bounds → proceed;
 *     expired / over-magnitude / over-daily-cap → prompt; deny wins; wildcard
 *     network; unreadable file degrades to prompt
 *   - grantConsent additive + idempotent; revokeConsent; listGrants
 *   - action-class + grant validation
 *   - file mode 0600 + atomic write
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertAuthorised,
  grantConsent,
  isValidActionClass,
  listGrants,
  loadConsent,
  resolveConsentFile,
  revokeConsent,
  saveConsent,
  type ConsentGrant,
} from '../../src/shared/consent.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-consent-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

const standing = (over: Partial<ConsentGrant> = {}): ConsentGrant => ({
  subject: 'acme',
  network: 'awin-advertiser',
  actionClass: 'publisher.approve',
  mode: 'standing',
  ...over,
});

describe('resolveConsentFile', () => {
  it('honours AFFILIATE_MCP_CONFIG_DIR on every call', () => {
    expect(resolveConsentFile()).toBe(path.join(tmp, 'consent.json'));
  });
});

describe('loadConsent', () => {
  it('returns the empty default when the file is missing', () => {
    expect(loadConsent()).toEqual({ version: 1, grants: [] });
  });

  it('throws on malformed JSON', () => {
    writeFileSync(path.join(tmp, 'consent.json'), '{ not valid json');
    expect(() => loadConsent()).toThrow(/not valid JSON/);
  });

  it('throws on a recognised-but-wrong shape', () => {
    writeFileSync(path.join(tmp, 'consent.json'), JSON.stringify({ version: 2, grants: [] }));
    expect(() => loadConsent()).toThrow(/unrecognised shape/);
  });

  it('throws when a grant has an invalid mode', () => {
    writeFileSync(
      path.join(tmp, 'consent.json'),
      JSON.stringify({ version: 1, grants: [{ subject: 'a', network: '*', actionClass: 'x.y', mode: 'maybe' }] }),
    );
    expect(() => loadConsent()).toThrow(/unrecognised shape/);
  });
});

describe('saveConsent + loadConsent round-trip', () => {
  it('persists and reads back the same structure', () => {
    const file = { version: 1 as const, grants: [standing({ grantedAt: '2026-01-01T00:00:00Z' })] };
    saveConsent(file);
    expect(loadConsent()).toEqual(file);
  });

  it('writes consent.json with mode 0600', () => {
    saveConsent({ version: 1, grants: [] });
    expect(statSync(path.join(tmp, 'consent.json')).mode & 0o077).toBe(0);
  });

  it('writes atomically — the .tmp sibling never lingers', () => {
    saveConsent({ version: 1, grants: [] });
    expect(existsSync(path.join(tmp, 'consent.json'))).toBe(true);
    expect(existsSync(path.join(tmp, 'consent.json.tmp'))).toBe(false);
  });
});

describe('assertAuthorised — base cases', () => {
  it('prompts when no grant exists', () => {
    const res = assertAuthorised({ subject: 'acme', network: 'awin-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('prompt');
    expect(res.grant).toBeUndefined();
    expect(res.reason).toMatch(/no standing grant/i);
  });

  it('proceeds on a matching standing grant with no bounds', () => {
    grantConsent(standing());
    const res = assertAuthorised({ subject: 'acme', network: 'awin-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('proceed');
    expect(res.grant?.actionClass).toBe('publisher.approve');
  });

  it('does not match a grant for a different action class', () => {
    grantConsent(standing());
    const res = assertAuthorised({ subject: 'acme', network: 'awin-advertiser', actionClass: 'commission.adjust' });
    expect(res.decision).toBe('prompt');
  });

  it('does not match a grant for a different network', () => {
    grantConsent(standing({ network: 'awin-advertiser' }));
    const res = assertAuthorised({ subject: 'acme', network: 'cj-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('prompt');
  });

  it('matches a wildcard-network grant for any network', () => {
    grantConsent(standing({ network: '*' }));
    const res = assertAuthorised({ subject: 'acme', network: 'cj-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('proceed');
  });
});

describe('assertAuthorised — bounds', () => {
  it('prompts when the grant has expired', () => {
    grantConsent(standing({ bounds: { expiresAt: '2026-01-01T00:00:00Z' } }));
    const res = assertAuthorised({
      subject: 'acme',
      network: 'awin-advertiser',
      actionClass: 'publisher.approve',
      now: new Date('2026-02-01T00:00:00Z'),
    });
    expect(res.decision).toBe('prompt');
    expect(res.reason).toMatch(/expired/);
  });

  it('proceeds before expiry', () => {
    grantConsent(standing({ bounds: { expiresAt: '2026-12-31T00:00:00Z' } }));
    const res = assertAuthorised({
      subject: 'acme',
      network: 'awin-advertiser',
      actionClass: 'publisher.approve',
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(res.decision).toBe('proceed');
  });

  it('prompts when magnitude exceeds the bound', () => {
    grantConsent(standing({ actionClass: 'commission.adjust', bounds: { maxMagnitude: 5 } }));
    const res = assertAuthorised({
      subject: 'acme',
      network: 'awin-advertiser',
      actionClass: 'commission.adjust',
      magnitude: 8,
    });
    expect(res.decision).toBe('prompt');
    expect(res.reason).toMatch(/magnitude 8 exceeds/);
  });

  it('proceeds when magnitude is within the bound', () => {
    grantConsent(standing({ actionClass: 'commission.adjust', bounds: { maxMagnitude: 5 } }));
    const res = assertAuthorised({
      subject: 'acme',
      network: 'awin-advertiser',
      actionClass: 'commission.adjust',
      magnitude: 3,
    });
    expect(res.decision).toBe('proceed');
  });

  it('prompts when the daily cap is reached', () => {
    grantConsent(standing({ bounds: { maxPerDay: 25 } }));
    const res = assertAuthorised({
      subject: 'acme',
      network: 'awin-advertiser',
      actionClass: 'publisher.approve',
      usedToday: 25,
    });
    expect(res.decision).toBe('prompt');
    expect(res.reason).toMatch(/daily cap/);
  });

  it('proceeds below the daily cap', () => {
    grantConsent(standing({ bounds: { maxPerDay: 25 } }));
    const res = assertAuthorised({
      subject: 'acme',
      network: 'awin-advertiser',
      actionClass: 'publisher.approve',
      usedToday: 24,
    });
    expect(res.decision).toBe('proceed');
  });
});

describe('assertAuthorised — deny wins', () => {
  it('denies when an explicit deny grant matches, even alongside a standing grant', () => {
    grantConsent(standing());
    grantConsent(standing({ network: '*', mode: 'deny' }));
    const res = assertAuthorised({ subject: 'acme', network: 'awin-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('deny');
    expect(res.grant?.mode).toBe('deny');
  });
});

describe('assertAuthorised — resilience', () => {
  it('degrades to prompt (never throws) when the consent file is unreadable', () => {
    writeFileSync(path.join(tmp, 'consent.json'), '{ broken');
    const res = assertAuthorised({ subject: 'acme', network: 'awin-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('prompt');
    expect(res.reason).toMatch(/unreadable/i);
  });
});

describe('grantConsent', () => {
  it('appends a new grant and stamps grantedAt', () => {
    grantConsent(standing());
    const grants = loadConsent().grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantedAt).toBeTypeOf('string');
  });

  it('is idempotent on (brand, network, actionClass) — replaces in place', () => {
    grantConsent(standing({ bounds: { maxPerDay: 10 } }));
    grantConsent(standing({ bounds: { maxPerDay: 50 } }));
    const grants = loadConsent().grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.bounds?.maxPerDay).toBe(50);
  });

  it('keeps distinct action classes as separate grants', () => {
    grantConsent(standing({ actionClass: 'publisher.approve' }));
    grantConsent(standing({ actionClass: 'publisher.decline' }));
    expect(loadConsent().grants).toHaveLength(2);
  });

  it('rejects an invalid brand slug and writes nothing', () => {
    expect(() => grantConsent(standing({ subject: 'Bad Slug!' }))).toThrow(/invalid/i);
    expect(existsSync(path.join(tmp, 'consent.json'))).toBe(false);
  });

  it('rejects an invalid action class', () => {
    expect(() => grantConsent(standing({ actionClass: 'notvalid' }))).toThrow(/domain\.verb/);
  });

  it('rejects negative bounds', () => {
    expect(() => grantConsent(standing({ bounds: { maxPerDay: -1 } }))).toThrow(/non-negative/);
  });
});

describe('revokeConsent', () => {
  it('removes a matching grant and returns the count', () => {
    grantConsent(standing());
    expect(revokeConsent('acme', 'awin-advertiser', 'publisher.approve')).toBe(1);
    expect(loadConsent().grants).toHaveLength(0);
  });

  it('returns 0 and writes nothing when no grant matches', () => {
    expect(revokeConsent('acme', 'awin-advertiser', 'publisher.approve')).toBe(0);
  });

  it('revoking returns the action to prompt', () => {
    grantConsent(standing());
    revokeConsent('acme', 'awin-advertiser', 'publisher.approve');
    const res = assertAuthorised({ subject: 'acme', network: 'awin-advertiser', actionClass: 'publisher.approve' });
    expect(res.decision).toBe('prompt');
  });
});

describe('listGrants', () => {
  it('lists all grants, or filters by brand', () => {
    grantConsent(standing({ subject: 'acme' }));
    grantConsent(standing({ subject: 'globex' }));
    expect(listGrants()).toHaveLength(2);
    expect(listGrants({ subject: 'acme' })).toHaveLength(1);
  });
});

describe('isValidActionClass', () => {
  it.each(['publisher.approve', 'commission.adjust', 'link.generate', 'a1.b2'])('accepts %s', (s) => {
    expect(isValidActionClass(s)).toBe(true);
  });
  it.each(['', 'publisher', 'a.b.c', 'Publisher.Approve', 'a .b', 'a-b.c'])('rejects %s', (s) => {
    expect(isValidActionClass(s)).toBe(false);
  });
});
