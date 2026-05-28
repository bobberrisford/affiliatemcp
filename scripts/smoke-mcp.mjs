// Throwaway smoke test: drive the local MCP server via the SDK client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist', 'index.js')],
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
