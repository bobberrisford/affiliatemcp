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
 * is optional and auto-derived from the token's own account (override only to
 * force a specific publisher). AWIN_BRAND_ID is the advertiser account to read
 * and defaults to 19011 (the Awin UK demo account).
 */

import '../src/networks/index.js';
import { getAdapter } from '../src/shared/registry.js';
import { registerBrand } from '../src/shared/brands.js';
import { verifyAuth as awinAuthVerify } from '../src/networks/awin/auth.js';
import { buildApplyToProgrammeHandoff } from '../src/networks/awin/actions.js';
import {
  buildApprovePublisherHandoff,
  buildDeclinePublisherHandoff,
} from '../src/networks/awin-advertiser/actions.js';
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
    // Use the auth module directly so we can read derivedValues and auto-fill
    // the token's OWN publisher id. A publisher token can only read its own
    // publisher, so forcing an unrelated id (e.g. an advertiser account) yields
    // a correct access_denied. Auto-derive unless the operator forced one.
    const r = await awinAuthVerify();
    if (!r.ok) throw new Error(r.reason);
    const derived = r.derivedValues?.AWIN_PUBLISHER_ID;
    if (derived && !process.env['AWIN_PUBLISHER_ID']) {
      process.env['AWIN_PUBLISHER_ID'] = derived;
    }
    const pid = process.env['AWIN_PUBLISHER_ID'] ?? 'unknown';
    return `${r.identity ?? 'authenticated'} (publisher id ${pid})`;
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

  const partners: Array<{ id: string; name: string; status: string; raw: unknown }> = [];
  await check('listMediaPartners(brand)', async () => {
    if (typeof adapter.listMediaPartners !== 'function') throw new Error('listMediaPartners not implemented');
    const list = await adapter.listMediaPartners({}, ctx);
    for (const p of list) partners.push({ id: p.id, name: p.name, status: p.status, raw: p.rawNetworkData });
    const pending = partners.filter((p) => p.status === 'pending').length;
    return `${partners.length} partner(s); ${pending} pending`;
  });

  const reportPublishers: Array<{ id: string; name: string }> = [];
  await check('getProgrammePerformance(30d, brand)', async () => {
    if (typeof adapter.getProgrammePerformance !== 'function') {
      throw new Error('getProgrammePerformance not implemented');
    }
    const rows = await adapter.getProgrammePerformance({ from, to }, ctx);
    const seen = new Set<string>();
    for (const r of rows) {
      if (!seen.has(r.publisherId)) {
        seen.add(r.publisherId);
        reportPublishers.push({ id: r.publisherId, name: r.publisherName });
      }
    }
    return `${rows.length} row(s); ${reportPublishers.length} distinct publisher(s)`;
  });

  // Diagnose the roster-vs-report mismatch: which publisher ids the roster call
  // returns versus which ones appear in the performance report.
  write('');
  write('  Diagnostic — listMediaPartners vs getProgrammePerformance publishers:');
  write(`    roster (${partners.length}): ${partners.map((p) => `${p.id} [${p.status}]`).join(', ') || 'none'}`);
  write(`    report (${reportPublishers.length}): ${reportPublishers.map((p) => p.id).join(', ') || 'none'}`);
  const rosterIds = new Set(partners.map((p) => p.id));
  const inReportNotRoster = reportPublishers.filter((p) => !rosterIds.has(p.id));
  write(`    in report but NOT in roster (${inReportNotRoster.length}): ${inReportNotRoster.map((p) => `${p.id} ${p.name}`).join(', ') || 'none'}`);
  if (partners.length > 0) {
    write(`    roster[0] raw: ${JSON.stringify(partners[0]?.raw)}`);
  }
}

/**
 * Emit each browser handoff and print its payload so a human (or Claude-in-
 * Chrome) can open the URLs in a logged-in Awin session and confirm they resolve
 * to the right page. An API token cannot verify these; this prints the exact
 * plan to execute and check by hand.
 */
function emitHandoffsForBrowserTest(): void {
  const brandId = process.env['AWIN_BRAND_ID'] ?? '19011';
  const publisherId = process.env['AWIN_PUBLISHER_ID'] ?? '587491';

  const handoffs = [
    buildApplyToProgrammeHandoff({
      publisherId,
      advertiserId: brandId,
      programmeName: `Awin advertiser ${brandId}`,
      brand: 'awin-demo',
      promotionMethodSummary: 'Content and social',
    }).browserFallback,
    buildApprovePublisherHandoff({
      brand: 'awin-demo',
      programmeId: brandId,
      publisherId: '999999',
      publisherName: 'Sample pending publisher',
    }).browserFallback,
    buildDeclinePublisherHandoff({
      brand: 'awin-demo',
      programmeId: brandId,
      publisherId: '999999',
      publisherName: 'Sample pending publisher',
      declineReason: 'Out of brand category',
    }).browserFallback,
  ];

  write('');
  write('Browser-handoff tests — open each URL in a LOGGED-IN Awin session and confirm:');
  write('(An API token cannot verify these. Confirm the page, then replace the');
  write(' TODO(verify) constants in the actions.ts files if a URL is wrong.)');
  for (const h of handoffs) {
    if (!h) continue;
    write('');
    write(`  GOAL:        ${h.goal}`);
    write(`  START URL:   ${h.startingUrl}`);
    write(`  VERIFY URL:  ${h.verify.url ?? '(none)'}`);
    write(`  VERIFY EXPECT: ${h.verify.expect}`);
    write(`  MUTATES:     ${h.mutates}`);
    write(`  CONSTRAINTS: ${h.constraints.length} rule(s) (payment/MFA/terms floor + per-action)`);
  }
  write('');
  write('  Checklist:');
  write('   [ ] START URL loads the intended page (not a 404 or a redirect to login)');
  write('   [ ] The page is the correct queue/list for the addressed brand');
  write('   [ ] VERIFY URL shows the state described in VERIFY EXPECT');
  write('   [ ] If any URL is wrong, note the correct path to update the emitter constant');
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
    // Do NOT default a publisher id. verifyPublisher auto-derives the token's
    // own id; AWIN_PUBLISHER_ID is honoured only if the operator sets it.
    const adapter = getAdapter('awin');
    if (adapter) await verifyPublisher(adapter);
    else write('awin adapter not registered');
  }

  if (advToken) {
    const adapter = getAdapter('awin-advertiser');
    if (adapter) await verifyAdvertiser(adapter);
    else write('awin-advertiser adapter not registered');
  }

  emitHandoffsForBrowserTest();

  write('');
  write(failures === 0 ? 'All live checks passed.' : `${failures} check(s) failed (see above).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
