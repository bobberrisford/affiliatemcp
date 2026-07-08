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

  it('lifted exclusions accept offset paging again', () => {
    // #316: optimise-media listProgrammes now pages /Campaigns to completion
    // when no limit is given, so tool-layer offset paging is honest there.
    expect(supportsOffsetPaging('optimise-media', 'listProgrammes')).toBe(true);
  });

  it('audited bounded-default pairs are excluded', () => {
    // impact-advertiser's exclusion was lifted in #316: all four paged ops now
    // paginate to completion on absent `limit`.
    expect(supportsOffsetPaging('impact-advertiser', 'getProgrammePerformance')).toBe(true);
    expect(supportsOffsetPaging('impact-advertiser', 'listProgrammes')).toBe(true);
    expect(supportsOffsetPaging('impact-advertiser', 'listTransactions')).toBe(true);
    expect(supportsOffsetPaging('impact-advertiser', 'listMediaPartners')).toBe(true);
    expect(supportsOffsetPaging('skimlinks', 'listTransactions')).toBe(false);
    // Found by the #314 independent review: flexoffers' page-paginated /allsales.
    expect(supportsOffsetPaging('flexoffers', 'listTransactions')).toBe(false);
    // Exclusion lifted (#316): the publisher-side partnerize adapter now
    // follows cursor_id continuation to completion on absent limit.
    expect(supportsOffsetPaging('partnerize', 'listTransactions')).toBe(true);
    expect(supportsOffsetPaging('partnerize', 'listProgrammes')).toBe(true);
    expect(supportsOffsetPaging('partnerize', 'listClicks')).toBe(true);
  });

  it('lifted exclusions paginate to completion and accept offset again (#316)', () => {
    // cj now follows page/totalCount (advertisers) and sinceCommissionId/
    // payloadComplete (publisherCommissions) to completion; see
    // tests/networks/cj/pagination.test.ts for the adapter-level proof.
    expect(supportsOffsetPaging('cj', 'listProgrammes')).toBe(true);
    expect(supportsOffsetPaging('cj', 'listTransactions')).toBe(true);
  });

  it('lifted exclusions support offset paging again', () => {
    // partnerize-advertiser now pages limit+offset to completion on absent
    // `limit` (issue #316); its exclusion was removed with that fix.
    expect(supportsOffsetPaging('partnerize-advertiser', 'listProgrammes')).toBe(true);
    expect(supportsOffsetPaging('partnerize-advertiser', 'listTransactions')).toBe(true);
    expect(supportsOffsetPaging('partnerize-advertiser', 'listMediaPartners')).toBe(true);
    expect(supportsOffsetPaging('partnerize-advertiser', 'getProgrammePerformance')).toBe(true);
  });

  it('cj-advertiser exclusion is lifted (#316: sinceCommissionId cursor loop to completion)', () => {
    expect(supportsOffsetPaging('cj-advertiser', 'listTransactions')).toBe(true);
    expect(supportsOffsetPaging('cj-advertiser', 'listMediaPartners')).toBe(true);
    expect(supportsOffsetPaging('cj-advertiser', 'getProgrammePerformance')).toBe(true);
  });

  it('everflow exclusion is lifted (#316: paginates to completion on absent limit)', () => {
    expect(supportsOffsetPaging('everflow', 'listProgrammes')).toBe(true);
    expect(supportsOffsetPaging('everflow', 'listTransactions')).toBe(true);
    expect(supportsOffsetPaging('everflow', 'listClicks')).toBe(true);
  });

  it('lifted exclusions support offset paging again (issue #316)', () => {
    // scaleo listProgrammes now paginates to completion; see
    // tests/networks/scaleo/pagination.test.ts for the behaviour proof.
    expect(supportsOffsetPaging('scaleo', 'listProgrammes')).toBe(true);
  });

  it('lifted exclusions support offset paging again (#316)', () => {
    // accesstrade listProgrammes now paginates to completion on absent limit.
    expect(supportsOffsetPaging('accesstrade', 'listProgrammes')).toBe(true);
  });
});
