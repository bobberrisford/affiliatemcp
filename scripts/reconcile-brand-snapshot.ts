#!/usr/bin/env tsx
/**
 * Brand-snapshot reconciliation harness.
 *
 * The quality gate for the brand data layer (decision
 * `2026-06-30-brand-data-layer.md`, brief §15): an adapter is not done until its
 * normalised confirmed/pending/declined totals for a window tie out to the
 * network's own dashboard for the same window.
 *
 * Usage (needs live credentials in ~/.affiliate-mcp/.env and a brand bound in
 * brands.json):
 *
 *   npx tsx scripts/reconcile-brand-snapshot.ts --brand acme \
 *     [--network awin-advertiser] [--asof 2026-06-30T12:00:00Z] \
 *     [--window last30d --currency GBP \
 *      --expect-confirmed 1234.56 --expect-pending 78.90 --expect-declined 12.00 \
 *      --expect-clicks 4567]
 *
 * Without --expect-* it prints the per-window figures for manual comparison.
 * With them it compares the named window/currency and exits non-zero on a
 * mismatch, so it can gate a release once a dashboard figure is captured.
 *
 * Output goes to stdout/stderr via process.write (not console) per the repo's
 * stdout-is-the-MCP-channel convention.
 */

import '../src/networks/index.js';
import { buildBrandSnapshot } from '../src/brand-data/snapshot.js';
import type { WindowKey } from '../src/brand-data/model.js';

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const err = (s: string): void => void process.stderr.write(`${s}\n`);

interface Args {
  brand?: string;
  network?: string;
  asof?: string;
  window?: string;
  currency?: string;
  'expect-confirmed'?: string;
  'expect-pending'?: string;
  'expect-declined'?: string;
  'expect-clicks'?: string;
}

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const key = a.slice(2) as keyof Args;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next;
        i += 1;
      }
    }
  }
  return result;
}

const money = (n: number): string => n.toFixed(2);
const near = (actual: number, expected: number, tolerance = 0.01): boolean =>
  Math.abs(actual - expected) <= tolerance;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.brand) {
    err('error: --brand <slug> is required');
    process.exit(2);
  }

  const options: Parameters<typeof buildBrandSnapshot>[1] = {};
  if (args.network) options.networks = [args.network];
  if (args.asof) options.asOf = args.asof;

  const { snapshot } = await buildBrandSnapshot(args.brand, options);

  out(`Brand: ${snapshot.brandId}  as of ${snapshot.generatedAt}  (${snapshot.timezone})`);
  out('Network health:');
  for (const h of snapshot.byNetwork) {
    out(`  ${h.network}: ${h.state}${h.note ? ` — ${h.note}` : ''}`);
  }

  const windowKeys: WindowKey[] = ['yesterday', 'last7d', 'last30d', 'ytd'];
  for (const key of windowKeys) {
    const win = snapshot.windows[key];
    out(`\n[${key}] ${win.from} .. ${win.to}`);
    for (const t of win.totals) {
      out(
        `  ${t.currency}: confirmed=${money(t.commission.confirmed)} pending=${money(
          t.commission.pending,
        )} declined=${money(t.commission.declined)} tracked=${money(
          t.commission.totalTracked,
        )} clicks=${t.clicks} epc=${t.epc === null ? 'n/a' : t.epc.toFixed(4)}`,
      );
    }
  }

  const hasExpect =
    args['expect-confirmed'] !== undefined ||
    args['expect-pending'] !== undefined ||
    args['expect-declined'] !== undefined ||
    args['expect-clicks'] !== undefined;
  if (!hasExpect) {
    out('\nNo --expect-* figures given; printed for manual comparison.');
    return;
  }

  const windowKey = (args.window ?? 'last30d') as WindowKey;
  const currency = args.currency ?? 'GBP';
  const row = snapshot.windows[windowKey]?.totals.find((t) => t.currency === currency);
  if (!row) {
    err(`\nFAIL: no totals for window=${windowKey} currency=${currency}`);
    process.exit(1);
  }

  const checks: Array<{ label: string; actual: number; expected: number }> = [];
  if (args['expect-confirmed'] !== undefined)
    checks.push({ label: 'confirmed', actual: row.commission.confirmed, expected: Number(args['expect-confirmed']) });
  if (args['expect-pending'] !== undefined)
    checks.push({ label: 'pending', actual: row.commission.pending, expected: Number(args['expect-pending']) });
  if (args['expect-declined'] !== undefined)
    checks.push({ label: 'declined', actual: row.commission.declined, expected: Number(args['expect-declined']) });
  if (args['expect-clicks'] !== undefined)
    checks.push({ label: 'clicks', actual: row.clicks, expected: Number(args['expect-clicks']) });

  let pass = true;
  out(`\nReconciliation [${windowKey} / ${currency}]:`);
  for (const c of checks) {
    const ok = near(c.actual, c.expected);
    if (!ok) pass = false;
    out(`  ${ok ? 'PASS' : 'FAIL'} ${c.label}: actual=${c.actual} expected=${c.expected}`);
  }
  if (!pass) {
    err('\nFAIL: snapshot does not reconcile to the provided dashboard figures.');
    process.exit(1);
  }
  out('\nPASS: snapshot reconciles to the provided dashboard figures.');
}

main().catch((e) => {
  err(`reconcile-brand-snapshot fatal: ${(e as Error).message}`);
  process.exit(1);
});
