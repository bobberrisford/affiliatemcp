import { describe, expect, it } from 'vitest';
import { PAGING_EXCLUSIONS, supportsOffsetPaging } from '../../src/tools/paging-exclusions.js';
import { LIST_OPS } from '../../src/tools/generate.js';
import { getAdapters } from '../../src/shared/registry.js';
import '../../src/networks/index.js';

describe('offset-paging exclusions', () => {
  it('every excluded slug names a registered adapter (no typo can silently no-op)', () => {
    const registered = new Set(getAdapters().map((a) => a.slug));
    for (const slug of PAGING_EXCLUSIONS.keys()) {
      expect(registered.has(slug), `unknown adapter slug "${slug}" in PAGING_EXCLUSIONS`).toBe(
        true,
      );
    }
  });

  it('every excluded operation is a pageable list op', () => {
    for (const [slug, ops] of PAGING_EXCLUSIONS) {
      for (const op of ops) {
        expect(LIST_OPS.has(op), `${slug}: "${op}" is not a pageable list op`).toBe(true);
      }
    }
  });

  it('advertiser-only exclusions sit on advertiser-side adapters', () => {
    const sides = new Map(getAdapters().map((a) => [a.slug, a.meta.side]));
    for (const [slug, ops] of PAGING_EXCLUSIONS) {
      if (ops.has('listMediaPartners') || ops.has('getProgrammePerformance')) {
        expect(sides.get(slug), `${slug} excludes advertiser ops but is not advertiser-side`).toBe(
          'advertiser',
        );
      }
    }
  });

  it('the reference adapter is not excluded', () => {
    expect(supportsOffsetPaging('awin', 'listTransactions')).toBe(true);
    expect(supportsOffsetPaging('awin', 'listProgrammes')).toBe(true);
  });

  it('audited bounded-default pairs are excluded', () => {
    expect(supportsOffsetPaging('cj', 'listTransactions')).toBe(false);
    expect(supportsOffsetPaging('cj', 'listClicks')).toBe(true); // only audited ops excluded
    expect(supportsOffsetPaging('impact-advertiser', 'getProgrammePerformance')).toBe(false);
    expect(supportsOffsetPaging('skimlinks', 'listTransactions')).toBe(false);
    // Found by the #314 independent review: the publisher side of the
    // partnerize family and flexoffers' page-paginated /allsales.
    expect(supportsOffsetPaging('partnerize', 'listTransactions')).toBe(false);
    expect(supportsOffsetPaging('flexoffers', 'listTransactions')).toBe(false);
  });
});
