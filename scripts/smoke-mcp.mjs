// Throwaway smoke test: drive the local MCP server via the SDK client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const entry = path.join(repoRoot, 'dist', 'index.js');

// Dispatch guard: prove the `cowork-mirror` subcommand is wired and its flag
// parser runs. Using a bogus flag keeps this hermetic — it errors in
// parseCoworkMirrorFlags before any GitHub/network work happens.
{
  const res = spawnSync('node', [entry, 'cowork-mirror', '--bogus'], { encoding: 'utf8' });
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 2 || !text.includes('Unknown flag for cowork-mirror')) {
    console.error(
      `✗ cowork-mirror dispatch guard failed (exit ${res.status}):`,
      text.trim() || '<no output>',
    );
    process.exit(1);
  }
  console.log('✓ cowork-mirror subcommand dispatches (exit 2 on bad flag)');
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [entry],
  cwd: repoRoot,
  stderr: 'pipe',
});

transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log('✓ connected (initialize handshake OK)');

  const tools = await client.listTools();
  console.log(`✓ tools/list: ${tools.tools.length} tools`);
  console.log('  first 5:', tools.tools.slice(0, 5).map((t) => t.name).join(', '));

  const prompts = await client.listPrompts();
  console.log(`✓ prompts/list: ${prompts.prompts.length} prompts`);

  await client.close();
  console.log('✓ closed cleanly');
  process.exit(0);
} catch (err) {
  console.error('✗ smoke failed:', err?.message ?? err);
  process.exit(1);
}
