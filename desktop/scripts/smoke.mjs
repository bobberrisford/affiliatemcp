// Bundle-load smoke for the packaged desktop app.
//
// The packaged app ships NO node_modules and NO `"type":"module"` marker, so it
// can only run if esbuild's self-contained CommonJS bundles (`build/core.cjs`,
// `build/server.cjs`) load under plain Node. This is the exact failure mode that
// has bitten before (raw ESM / unbundled deps in the packaged app). `npm run
// verify:desktop` runs the bundle step and then this smoke so the breakage is
// caught without needing a full electron-builder package + signing run.
//
// What it checks:
//   1. core.cjs require()s cleanly and exposes every facade fn main.js calls.
//   2. core.listNetworks() returns a populated list (the registry was wired in).
//   3. server.cjs is a valid, loadable CJS bundle (`node --check`). We don't run
//      it — with no args its main() starts the stdio MCP server and would block.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, '..', 'build');
const corePath = path.join(buildDir, 'core.cjs');
const serverPath = path.join(buildDir, 'server.cjs');

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

for (const p of [corePath, serverPath]) {
  if (!existsSync(p)) fail(`missing ${path.relative(process.cwd(), p)} — run \`npm run bundle\` first.`);
}

// 1) core.cjs must require() cleanly and expose the facade surface main.js drives.
const require = createRequire(import.meta.url);
let core;
try {
  core = require(corePath);
} catch (err) {
  fail(`core.cjs failed to load: ${err instanceof Error ? err.message : String(err)}`);
}
const facadeFns = [
  'listNetworks',
  'setupSteps',
  'validateField',
  'verifyAuth',
  'discoverBrands',
  'saveEnv',
  'saveBrands',
  'connectClaudeDesktop',
  'detectClients',
];
const missing = facadeFns.filter((k) => typeof core[k] !== 'function');
if (missing.length) fail(`core.cjs is missing facade exports: ${missing.join(', ')}`);

// 2) The adapter registry must be populated by the time the bundle loads.
const networks = core.listNetworks();
if (!Array.isArray(networks) || networks.length === 0) {
  fail('core.listNetworks() returned no networks — the registry was not wired in.');
}

// 3) server.cjs must be a loadable CJS bundle. `node --check` parses without
//    executing main() (which would start the stdio server and block).
try {
  execFileSync(process.execPath, ['--check', serverPath], { stdio: 'pipe', timeout: 30_000 });
} catch (err) {
  fail(`server.cjs did not parse as a CJS bundle: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(
  `[smoke] ok — core.cjs exposes ${facadeFns.length} facade fns and ${networks.length} networks; server.cjs is a valid CJS bundle.`,
);
