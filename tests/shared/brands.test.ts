/**
 * Tests for `src/shared/brands.ts`.
 *
 * Covers:
 *   - load/save round-trip
 *   - missing-file default
 *   - resolution success + failure
 *   - registerBrand additive and idempotent semantics
 *   - listBrandsForNetwork
 *   - slug validation + slug suggestion
 *   - file mode 0600 + atomic write
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isValidBrandSlug,
  listBrandsForNetwork,
  loadBrands,
  registerBrand,
  resolveBrand,
  resolveBrandsFile,
  saveBrands,
  suggestSlug,
} from '../../src/shared/brands.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-brands-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

describe('resolveBrandsFile', () => {
  it('honours AFFILIATE_MCP_CONFIG_DIR on every call', () => {
    const file = resolveBrandsFile();
    expect(file).toBe(path.join(tmp, 'brands.json'));
  });
});

describe('loadBrands', () => {
  it('returns the empty default when the file is missing', () => {
    expect(loadBrands()).toEqual({ version: 1, brands: {} });
  });

  it('throws on malformed JSON', () => {
    writeFileSync(path.join(tmp, 'brands.json'), '{ not valid json');
    expect(() => loadBrands()).toThrow(/not valid JSON/);
  });

  it('throws on a recognised-but-wrong shape', () => {
    writeFileSync(path.join(tmp, 'brands.json'), JSON.stringify({ version: 2, brands: {} }));
    expect(() => loadBrands()).toThrow(/unrecognised shape/);
  });
});

describe('saveBrands + loadBrands round-trip', () => {
  it('persists and reads back the same structure', () => {
    const file = {
      version: 1 as const,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
        globex: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-9' },
          { network: 'cj-advertiser', credentialId: 'default', networkBrandId: '7654321' },
        ],
      },
    };
    saveBrands(file);
    expect(loadBrands()).toEqual(file);
  });

  it('writes brands.json with mode 0600', () => {
    saveBrands({ version: 1, brands: { acme: [] } });
    const stat = statSync(path.join(tmp, 'brands.json'));
    expect(stat.mode & 0o077).toBe(0);
  });

  it('writes atomically — the .tmp sibling never lingers', () => {
    saveBrands({ version: 1, brands: { acme: [] } });
    expect(existsSync(path.join(tmp, 'brands.json'))).toBe(true);
    expect(existsSync(path.join(tmp, 'brands.json.tmp'))).toBe(false);
  });
});

describe('resolveBrand', () => {
  it('returns the binding when one exists', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    expect(resolveBrand('acme', 'impact-advertiser')).toEqual({
      credentialId: 'default',
      networkBrandId: 'IA-1',
    });
  });

  it('returns null when the brand is unknown', () => {
    expect(resolveBrand('unknown', 'impact-advertiser')).toBeNull();
  });

  it('returns null when the brand exists but not for that network', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    expect(resolveBrand('acme', 'cj-advertiser')).toBeNull();
  });
});

describe('listBrandsForNetwork', () => {
  it('lists every brand bound to the named network', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' },
          { network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-1' },
        ],
        globex: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-9' },
        ],
      },
    });
    const list = listBrandsForNetwork('impact-advertiser');
    const slugs = list.map((b) => b.slug).sort();
    expect(slugs).toEqual(['acme', 'globex']);
  });

  it('returns [] when nothing is registered', () => {
    expect(listBrandsForNetwork('impact-advertiser')).toEqual([]);
  });
});

describe('registerBrand', () => {
  it('appends a new binding', () => {
    registerBrand('acme', 'impact-advertiser', 'default', 'IA-1');
    expect(loadBrands().brands['acme']).toEqual([
      { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' },
    ]);
  });

  it('appends across multiple networks for the same slug', () => {
    registerBrand('acme', 'impact-advertiser', 'default', 'IA-1');
    registerBrand('acme', 'cj-advertiser', 'default', 'CJ-1');
    expect(loadBrands().brands['acme']).toEqual([
      { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' },
      { network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-1' },
    ]);
  });

  it('is idempotent on (slug, network) — second call replaces in place', () => {
    registerBrand('acme', 'impact-advertiser', 'default', 'IA-1');
    registerBrand('acme', 'impact-advertiser', 'default', 'IA-2');
    expect(loadBrands().brands['acme']).toEqual([
      { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-2' },
    ]);
  });

  it('rejects an invalid brand slug', () => {
    expect(() => registerBrand('Bad Slug!', 'impact-advertiser', 'default', 'IA-1')).toThrow(
      /invalid/i,
    );
  });

  it('does not write the file if the slug is invalid', () => {
    try {
      registerBrand('BAD', 'impact-advertiser', 'default', 'IA-1');
    } catch {
      /* expected */
    }
    expect(existsSync(path.join(tmp, 'brands.json'))).toBe(false);
  });
});

describe('isValidBrandSlug', () => {
  it.each(['acme', 'acme-co', 'a1', 'a-1-b'])('accepts %s', (s) => {
    expect(isValidBrandSlug(s)).toBe(true);
  });
  it.each(['', 'ACME', 'acme corp', 'acme_corp', 'acme!', 'acme/co'])('rejects %s', (s) => {
    expect(isValidBrandSlug(s)).toBe(false);
  });
});

describe('suggestSlug', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(suggestSlug('Acme Corp')).toBe('acme-corp');
    expect(suggestSlug('Globex (UK)')).toBe('globex-uk');
    expect(suggestSlug('  trim me  ')).toBe('trim-me');
  });
  it('collapses runs of hyphens', () => {
    expect(suggestSlug('a---b')).toBe('a-b');
  });
});

// Ensure the round-trip text is readable JSON, useful for git diffs etc.
describe('brands.json on-disk format', () => {
  it('is pretty-printed JSON', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const text = readFileSync(path.join(tmp, 'brands.json'), 'utf8');
    expect(text).toMatch(/^\{\n {2}"version": 1/);
  });
});
