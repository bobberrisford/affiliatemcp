/**
 * `affiliate-mcp cache <subcommand>` — manage the on-disk response cache.
 *
 * Subcommands:
 *   - `clear` — delete every cache file. The cache directory itself is
 *     preserved so subsequent calls can write into it.
 *
 * Output goes to stdout because `cache` is an interactive CLI surface,
 * not the MCP server. Mirrors `setup.ts` / `doctor.ts` conventions.
 */
import { cacheDir, clearCache } from '../shared/cache.js';

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

export interface CacheCommandOptions {
  subcommand?: string;
}

export function runCache(opts: CacheCommandOptions = {}): number {
  const sub = opts.subcommand;
  switch (sub) {
    case 'clear': {
      const { removed, dir } = clearCache();
      out(`Cleared ${removed} cache ${removed === 1 ? 'entry' : 'entries'} from ${dir}.`);
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      out('Usage: affiliate-networks-mcp cache <subcommand>');
      out('');
      out('Subcommands:');
      out(`  clear   Delete every cached response in ${cacheDir()}.`);
      return sub === undefined ? 2 : 0;
    }
    default: {
      out(`Unknown cache subcommand: ${sub}`);
      out('Run `affiliate-networks-mcp cache --help` for usage.');
      return 2;
    }
  }
}
