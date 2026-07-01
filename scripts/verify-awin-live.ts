/**
 * Live Awin verification harness.
 *
 * Exercises the real Awin publisher and advertiser adapter read paths against a
 * live account (client -> withResilience -> fetch), so it is a true end-to-end
 * check, not a raw curl. It prints PASS/FAIL per operation with a one-line data
 * summary or the verbatim error envelope, and lists the browser-handoff URLs
 * that still need a manual UI pass (an API token cannot verify those).
 *
 * It reads credentials from the environment only; it writes nothing and stores
 * no token. Nothing is committed but this script.
 *
 * Usage (run where api.awin.com is reachable):
 *
 *   AWIN_API_TOKEN=<token> \
 *   AWIN_ADVERTISER_API_TOKEN=<token> \
 *   AWIN_BRAND_ID=19011 \
 *   npx tsx scripts/verify-awin-live.ts
 *
 * Provide only the token(s) for the side(s) you want to check. AWIN_PUBLISHER_ID
 * and AWIN_BRAND_ID default to 19011 (the Awin UK demo account).
 */

import '../src/networks/index.js';
import { getAdapter } from '../src/shared/registry.js';
import { registerBrand } from '../src/shared/brands.js';
import { awinActionDescriptors } from '../src/networks/awin/actions.js';
import { awinAdvertiserActionDescriptors } from '../src/networks/awin-advertiser/actions.js';
import type { AdapterCallContext, NetworkAdapter } from '../src/shared/types.js';

function write(line = ''): void {
  process.stdout.write(`${line}\n`);
}

let failures = 0;

/** Run one labelled check; print PASS with a summary or FAIL with the reason. */
async function check(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    const summary = await fn();
    write(`  PASS  ${label}${summary ? ` — ${summary}` : ''}`);
  } catch (err) {
    failures += 1;
    const envelope = (err as { envelope?: unknown }).envelope;
    if (envelope) {
      write(`  FAIL  ${label} — ${JSON.stringify(envelope)}`);
    } else {
      write(`  FAIL  ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** A 30-day window ending yesterday, as ISO strings. */
function lastThirtyDays(): { from: string; to: string } {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function verifyPublisher(adapter: NetworkAdapter): Promise<void> {
  write('');
  write('Awin publisher (awin):');
  const { from, to } = lastThirtyDays();

  let firstJoinedAdvertiserId: string | undefined;

  await check('verifyAuth', async () => {
    const r = await adapter.verifyAuth();
    if (!r.ok) throw new Error(r.reason);
    return r.identity ? `identity ${r.identity}` : 'authenticated';
  });

  await check('listProgrammes', async () => {
    const programmes = await adapter.listProgrammes({ limit: 5 });
    firstJoinedAdvertiserId = programmes[0]?.id;
    return `${programmes.length} programme(s)`;
  });

  await check('listTransactions(30d)', async () => {
    const txns = await adapter.listTransactions({ from, to });
    const byStatus = txns.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
    return `${txns.length} txn(s); statuses ${JSON.stringify(byStatus)}`;
  });

  await check('getEarningsSummary(30d)', async () => {
    const summary = await adapter.getEarningsSummary({ from, to });
    return `total ${summary.totalEarnings} ${summary.currency}`;
  });

  await check('generateTrackingLink (deterministic, no network)', async () => {
    const link = await adapter.generateTrackingLink({
      programmeId: firstJoinedAdvertiserId ?? '1001',
      destinationUrl: 'https://example.com/product',
    });
    return link.trackingUrl;
  });
}

async function verifyAdvertiser(adapter: NetworkAdapter): Promise<void> {
  write('');
  write('Awin advertiser (awin-advertiser):');
  const { from, to } = lastThirtyDays();
  const brandId = process.env['AWIN_BRAND_ID'] ?? '19011';
  const brandSlug = 'awin-demo';

  await check('listBrands', async () => {
    if (typeof adapter.listBrands !== 'function') throw new Error('listBrands not implemented');
    const brands = await adapter.listBrands();
    const found = brands.find((b) => b.networkBrandId === brandId);
    return `${brands.length} advertiser account(s); brand ${brandId} ${found ? 'present' : 'NOT in list'}`;
  });

  // Bind the demo brand so brand-scoped reads resolve without brands.json.
  registerBrand(brandSlug, adapter.slug, 'default', brandId);
  const ctx: AdapterCallContext = { networkBrandId: brandId };

  await check('listTransactions(30d, brand)', async () => {
    const txns = await adapter.listTransactions({ from, to }, ctx);
    return `${txns.length} txn(s)`;
  });

  await check('listMediaPartners(brand)', async () => {
    if (typeof adapter.listMediaPartners !== 'function') throw new Error('listMediaPartners not implemented');
    const partners = await adapter.listMediaPartners({}, ctx);
    const pending = partners.filter((p) => p.status === 'pending').length;
    return `${partners.length} partner(s); ${pending} pending`;
  });

  await check('getProgrammePerformance(30d, brand)', async () => {
    if (typeof adapter.getProgrammePerformance !== 'function') {
      throw new Error('getProgrammePerformance not implemented');
    }
    const rows = await adapter.getProgrammePerformance({ from, to }, ctx);
    return `${rows.length} publisher row(s)`;
  });
}

function printHandoffUrlsToVerifyManually(): void {
  write('');
  write('Browser-handoff URLs needing a MANUAL UI pass (an API token cannot verify these):');
  for (const d of [...awinActionDescriptors, ...awinAdvertiserActionDescriptors]) {
    write(`  - ${d.id} (${d.channel}/${d.effect})`);
  }
  write('  Confirm the pending-queue and application-list paths against the live');
  write('  dashboard, then replace the TODO(verify) constants in the actions.ts files.');
}

async function main(): Promise<void> {
  write('Awin live verification');
  write('======================');

  const pubToken = process.env['AWIN_API_TOKEN'];
  const advToken = process.env['AWIN_ADVERTISER_API_TOKEN'];

  if (!pubToken && !advToken) {
    write('');
    write('No token provided. Set AWIN_API_TOKEN and/or AWIN_ADVERTISER_API_TOKEN.');
    process.exitCode = 2;
    return;
  }

  if (pubToken) {
    if (!process.env['AWIN_PUBLISHER_ID']) process.env['AWIN_PUBLISHER_ID'] = '19011';
    const adapter = getAdapter('awin');
    if (adapter) await verifyPublisher(adapter);
    else write('awin adapter not registered');
  }

  if (advToken) {
    const adapter = getAdapter('awin-advertiser');
    if (adapter) await verifyAdvertiser(adapter);
    else write('awin-advertiser adapter not registered');
  }

  printHandoffUrlsToVerifyManually();

  write('');
  write(failures === 0 ? 'All live checks passed.' : `${failures} check(s) failed (see above).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
