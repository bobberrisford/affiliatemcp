/**
 * Tests for `scripts/scaffold-network.ts`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildContext,
  planScaffold,
  transform,
} from '../../scripts/scaffold-network.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('scaffold-network buildContext', () => {
  it('derives dir, name, class and env var from a publisher slug', () => {
    const ctx = buildContext({ slug: 'tradedoubler' });
    expect(ctx.dir).toBe('tradedoubler');
    expect(ctx.name).toBe('Tradedoubler');
    expect(ctx.pascal).toBe('Tradedoubler');
    expect(ctx.envVar).toBe('TRADEDOUBLER_API_TOKEN');
  });

  it('suffixes the advertiser side across dir, class and env var', () => {
    const ctx = buildContext({ slug: 'partnerize', advertiser: true });
    expect(ctx.dir).toBe('partnerize-advertiser');
    expect(ctx.name).toBe('Partnerize (advertiser)');
    expect(ctx.pascal).toBe('PartnerizeAdvertiser');
    expect(ctx.envVar).toBe('PARTNERIZE_ADVERTISER_API_TOKEN');
  });

  it('honours an explicit --name', () => {
    expect(buildContext({ slug: 'ebay', name: 'eBay Partner Network' }).name).toBe(
      'eBay Partner Network',
    );
  });

  it('rejects a non-kebab slug', () => {
    expect(() => buildContext({ slug: 'Bad Slug' })).toThrow(/kebab/);
  });
});

describe('scaffold-network transform', () => {
  const ctx = buildContext({ slug: 'tradedoubler' });

  it('replaces the adapter SLUG, class name and display name', () => {
    const src = [
      "const SLUG = 'TEMPLATE_NETWORK';",
      "  name: 'TEMPLATE_NETWORK',",
      'export class TemplateNetworkAdapter {}',
    ].join('\n');
    const out = transform(src, ctx, false);
    expect(out).toContain("const SLUG = 'tradedoubler';");
    expect(out).toContain("name: 'Tradedoubler',");
    expect(out).toContain('export class TradedoublerAdapter {}');
    expect(out).not.toContain('TEMPLATE_NETWORK');
  });

  it('switches the side when advertiser', () => {
    const advCtx = buildContext({ slug: 'tradedoubler', advertiser: true });
    const out = transform("  side: 'publisher',\n\"side\": \"publisher\"", advCtx, true);
    expect(out).toContain("side: 'advertiser'");
    expect(out).toContain('"side": "advertiser"');
  });
});

describe('scaffold-network planScaffold', () => {
  it('emits the six adapter files plus a fixtures keepfile, all under the slug dir', () => {
    const files = planScaffold(repoRoot, { slug: 'tradedoubler' });
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain('src/networks/tradedoubler/adapter.ts');
    expect(paths).toContain('src/networks/tradedoubler/network.json');
    expect(paths).toContain('docs/networks/tradedoubler.md');
    expect(paths).toContain('tests/networks/tradedoubler/fixtures/.gitkeep');

    const networkJson = files.find((f) => f.relPath.endsWith('network.json'))!;
    expect(networkJson.content).toContain('"slug": "tradedoubler"');
    expect(networkJson.content).toContain('TRADEDOUBLER_API_TOKEN');
    expect(networkJson.content).not.toContain('template-network');
  });
});
