#!/usr/bin/env tsx
/**
 * New-network adapter scaffolder.
 *
 * CLI: `npm run scaffold:network -- <slug> [--name "Human Name"] [--advertiser]`
 *
 * Copies `templates/new-network/` into `src/networks/<slug>/`, substitutes the
 * template placeholders, drops the setup doc into `docs/networks/<slug>.md`,
 * and stubs `tests/networks/<slug>/fixtures/`. It does not touch
 * `src/networks/index.ts` — wiring the one import line is a deliberate manual
 * step (see the printed checklist).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScaffoldOptions {
  slug: string;
  name?: string;
  advertiser?: boolean;
}

export interface ScaffoldFile {
  /** Path relative to the repo root. */
  relPath: string;
  content: string;
}

export interface ScaffoldContext {
  /** Directory slug — `<slug>` or `<slug>-advertiser`. */
  dir: string;
  name: string;
  pascal: string;
  envVar: string;
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function pascalCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

export function buildContext(opts: ScaffoldOptions): ScaffoldContext {
  const baseSlug = opts.slug.trim().toLowerCase();
  if (!SLUG_RE.test(baseSlug)) {
    throw new Error(`Invalid slug "${opts.slug}". Use lowercase kebab-case, e.g. "tradedoubler".`);
  }
  const dir = opts.advertiser ? `${baseSlug}-advertiser` : baseSlug;
  const upper = dir.toUpperCase().replace(/-/g, '_');
  const baseName = opts.name?.trim() || titleCase(baseSlug);
  const name = opts.advertiser ? `${baseName} (advertiser)` : baseName;
  return {
    dir,
    name,
    pascal: pascalCase(dir),
    envVar: `${upper}_API_TOKEN`,
  };
}

/**
 * Apply the template placeholder substitutions to one file's content. Pure;
 * harmless for files that contain none of the patterns.
 */
export function transform(content: string, ctx: ScaffoldContext, advertiser: boolean): string {
  let out = content
    .replace("const SLUG = 'TEMPLATE_NETWORK';", `const SLUG = '${ctx.dir}';`)
    .replace("name: 'TEMPLATE_NETWORK',", `name: '${ctx.name}',`)
    .replaceAll('TemplateNetworkAdapter', `${ctx.pascal}Adapter`)
    .replaceAll('"slug": "template-network"', `"slug": "${ctx.dir}"`)
    .replaceAll('"name": "Template Network"', `"name": "${ctx.name}"`)
    .replaceAll('TEMPLATE_NETWORK_API_TOKEN', ctx.envVar)
    .replaceAll('<NETWORK_NAME>', ctx.name)
    .replaceAll('<slug>', ctx.dir);
  if (advertiser) {
    out = out
      .replaceAll("side: 'publisher'", "side: 'advertiser'")
      .replaceAll('"side": "publisher"', '"side": "advertiser"');
  }
  return out;
}

const TEMPLATE_FILES: ReadonlyArray<{ src: string; dest: (ctx: ScaffoldContext) => string }> = [
  { src: 'network.json', dest: (c) => `src/networks/${c.dir}/network.json` },
  { src: 'adapter.ts', dest: (c) => `src/networks/${c.dir}/adapter.ts` },
  { src: 'auth.ts', dest: (c) => `src/networks/${c.dir}/auth.ts` },
  { src: 'client.ts', dest: (c) => `src/networks/${c.dir}/client.ts` },
  { src: 'setup.ts', dest: (c) => `src/networks/${c.dir}/setup.ts` },
  { src: 'README.md', dest: (c) => `docs/networks/${c.dir}.md` },
];

export function planScaffold(repoRoot: string, opts: ScaffoldOptions): ScaffoldFile[] {
  const ctx = buildContext(opts);
  const templateDir = path.join(repoRoot, 'templates', 'new-network');
  const files = TEMPLATE_FILES.map(({ src, dest }) => {
    const raw = readFileSync(path.join(templateDir, src), 'utf8');
    return { relPath: dest(ctx), content: transform(raw, ctx, opts.advertiser === true) };
  });
  files.push({
    relPath: `tests/networks/${ctx.dir}/fixtures/.gitkeep`,
    content: '',
  });
  return files;
}

function parseArgs(argv: string[]): ScaffoldOptions {
  let slug: string | undefined;
  let name: string | undefined;
  let advertiser = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--advertiser') {
      advertiser = true;
    } else if (arg === '--name') {
      name = argv[(i += 1)];
    } else if (!arg.startsWith('--') && slug === undefined) {
      slug = arg;
    }
  }
  if (slug === undefined) {
    throw new Error('Usage: npm run scaffold:network -- <slug> [--name "Name"] [--advertiser]');
  }
  return { slug, name, advertiser };
}

function runCli(): number {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const opts = parseArgs(process.argv.slice(2));
  const ctx = buildContext(opts);

  const adapterDir = path.join(repoRoot, 'src', 'networks', ctx.dir);
  if (existsSync(adapterDir)) {
    throw new Error(`src/networks/${ctx.dir}/ already exists — refusing to overwrite.`);
  }

  const files = planScaffold(repoRoot, opts);
  for (const f of files) {
    const abs = path.join(repoRoot, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
  }

  process.stderr.write(
    [
      `Scaffolded ${ctx.name} into src/networks/${ctx.dir}/.`,
      '',
      'Next steps (full detail in CONTRIBUTING.md → "Adopting your network"):',
      '  1. Implement auth.ts and client.ts.',
      '  2. Implement the seven canonical operations in adapter.ts.',
      `  3. Fill in src/networks/${ctx.dir}/network.json honestly (strip the _comment_* keys).`,
      `  4. Finish the setup doc at docs/networks/${ctx.dir}.md.`,
      `  5. Add fixtures + tests under tests/networks/${ctx.dir}/ (scrub credentials).`,
      `  6. Wire the adapter into src/networks/index.ts (one import line).`,
      `  7. npm run validate:network -- ${ctx.dir} && npm run generate:readme && npm run generate:report`,
      '  8. Open a PR with the new-network template.',
      '',
    ].join('\n'),
  );
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1]?.endsWith('scaffold-network.ts') === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exit(runCli());
  } catch (err) {
    process.stderr.write(`scaffold-network: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
