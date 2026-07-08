/**
 * Offset-paging exclusions.
 *
 * Tool-layer paging (decision 2026-07-03 §4) withholds `limit` from the
 * adapter and slices the full result locally. That is only honest when an
 * absent `limit` makes the adapter pull the complete result set (the Awin
 * reference pattern: pagination to completion or a full-window pull, with
 * `limit` as a local slice). A 2026-07-03 fleet audit found adapters where an
 * absent `limit` instead yields a single upstream default page with no
 * continuation — there, a paged call would silently slice within page one and
 * return wrong-but-plausible data.
 *
 * Those (network, operation) pairs are excluded here: their tools do not
 * accept `offset` at all, so a paging attempt fails loudly at the schema
 * boundary instead of lying. Remove an entry only when the adapter has been
 * changed (or verified) to pull to completion on absent `limit`, and say so
 * in that adapter's PR.
 *
 * Two groups, both excluded conservatively:
 *   - confirmed bounded defaults: the adapter code fetches one page with a
 *     default size and never continues;
 *   - unverified upstream defaults: the adapter sends no paging parameter, the
 *     upstream API is documented as paginated, and the server-side default
 *     page size is not evidenced in-repo.
 */

import type { AdapterOperation } from '../shared/types.js';

const ops = (...list: AdapterOperation[]): ReadonlySet<AdapterOperation> => new Set(list);

export const PAGING_EXCLUSIONS: ReadonlyMap<string, ReadonlySet<AdapterOperation>> = new Map<
  string,
  ReadonlySet<AdapterOperation>
>([
  // Confirmed bounded defaults (adapter fetches one page, never continues).
  ['accesstrade', ops('listProgrammes')], // limit default, page 1, single fetch
  ['offer18', ops('listProgrammes')], // first page only, by design comment
  ['optimise-media', ops('listProgrammes')], // page 1, default pageSize
  ['admitad', ops('listProgrammes')], // offset:0 fixed against an offset-paginated endpoint
  ['travelpayouts', ops('listProgrammes')], // programmes synthesised from a single 300-row actions page
  ['kwanko-advertiser', ops('listProgrammes')], // per_page default, single request
  // impact-advertiser was removed 2026-07-04 (#316): its four paged ops now
  // paginate to completion on absent `limit` via @nextpageuri/@page with a
  // MAX_PAGES backstop; see src/networks/impact-advertiser/adapter.ts.
  // cj-advertiser removed 2026-07-04 (#316): the adapter now follows the
  // commissionDetails `sinceCommissionId` cursor to completion on absent
  // `limit`, MAX_PAGES-capped with a stderr warning.
  // Unverified upstream defaults (no paging param sent, upstream documented as
  // paginated, server-side default page size not evidenced in-repo).
  ['skimlinks', ops('listTransactions')],
  ['value-commerce', ops('listTransactions')],
  ['kwanko', ops('listProgrammes', 'listTransactions')],
  ['indoleads', ops('listProgrammes', 'listTransactions')],
  ['mrge', ops('listProgrammes', 'listTransactions')],
  ['flexoffers', ops('listTransactions')], // /allsales is page-paginated per adapter.ts:424 with the parameter BLOCKED(verify); no page param is sent
]);

/** Whether tool-layer offset paging is honest for this (network, operation). */
export function supportsOffsetPaging(networkSlug: string, op: AdapterOperation): boolean {
  return PAGING_EXCLUSIONS.get(networkSlug)?.has(op) !== true;
}
