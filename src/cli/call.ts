/**
 * `affiliate-networks-mcp call`: invoke any network operation from the terminal.
 *
 * This is the command-line surface over the affiliate networks. It reuses the
 * exact same `ToolDefinition` registry that backs the MCP server
 * (`generateAllTools`), so the CLI and MCP share one code path across every
 * registered network and operation; there is no per-network CLI code to keep
 * in sync.
 *
 * Usage:
 *   affiliate-networks-mcp call --list [--network <slug>]
 *   affiliate-networks-mcp call --describe <tool-or-network> [<operation>]
 *   affiliate-networks-mcp call <tool-name> [key=value ...] [--args '<json>']
 *   affiliate-networks-mcp call <network> <operation> [key=value ...]
 *
 * Argument forms (merged; later sources win):
 *   - `key=value` pairs:  each value is coerced to the type the tool's input
 *                         schema declares for that key. String fields keep
 *                         their raw value (so `programmeId=12345` stays the
 *                         string "12345", not a number); number/boolean
 *                         fields are converted; array fields accept either a
 *                         JSON array or a comma-separated list
 *                         (`status=approved,pending`).
 *   - `--args '<json>'`:  a full JSON object of arguments (already typed).
 *
 * Output rules: the JSON result is written to stdout (pretty-printed), matching
 * the MCP server's serialisation. Failures round-trip through a
 * `NetworkErrorEnvelope` (PRD principle 4.1) printed to stderr, and the process
 * exits non-zero. Pino still logs to stderr.
 */

import { generateAllTools, type ToolDefinition } from '../tools/generate.js';
import { isErrorEnvelope, NetworkError, toErrorEnvelope } from '../shared/errors.js';
import { getAdapters } from '../shared/registry.js';
import { buildEntitlementRequired, GATED_TOOLS, isEntitled } from '../brand-data/entitlement.js';

function out(line = ''): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

function err(line = ''): void {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

/**
 * Resolve a tool name `affiliate_<slug>_<op>` back to its registered network
 * slug, or 'meta' for the meta tools (`affiliate_list_networks`,
 * `affiliate_run_diagnostic`, `affiliate_resolve_brand`).
 *
 * Slugs never contain underscores, so the second underscore-separated token is
 * the whole slug candidate. Two wrinkles, both registry-driven:
 *   - the generator abbreviates an over-length `-advertiser` slug to `-adv`
 *     (64-char MCP tool-name cap), so `-adv` expands back before matching;
 *   - meta tool names also start with `affiliate_`, so the candidate must
 *     actually be a registered slug, otherwise the tool is grouped as 'meta'.
 */
function networkOf(toolName: string, slugs: ReadonlySet<string>): string {
  const parts = toolName.split('_');
  if (parts.length >= 3 && parts[0] === 'affiliate' && parts[1] !== undefined) {
    const candidate = parts[1];
    if (slugs.has(candidate)) return candidate;
    const expanded = candidate.replace(/-adv$/, '-advertiser');
    if (slugs.has(expanded)) return expanded;
  }
  return 'meta';
}

function registeredSlugs(): ReadonlySet<string> {
  return new Set(getAdapters().map((a) => a.slug));
}

/** camelCase or snake_case operation → the snake form used in tool names. */
function snakeOp(op: string): string {
  return op
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/__+/g, '_')
    .replace(/^_/, '');
}

interface ParsedArgs {
  list: boolean;
  describe: boolean;
  networkFilter?: string;
  positionals: string[];
  kvPairs: string[];
  jsonArgs?: string;
}

function parse(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { list: false, describe: false, positionals: [], kvPairs: [] };
  const requireValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--list':
      case '-l':
        parsed.list = true;
        break;
      case '--describe':
        parsed.describe = true;
        break;
      case '--network': {
        parsed.networkFilter = requireValue(arg, i);
        i += 1;
        break;
      }
      case '--args':
      case '--json': {
        parsed.jsonArgs = requireValue(arg, i);
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag for call: ${arg}`);
        }
        // `key=value` is an argument; a bare token is a positional (tool name,
        // network slug, or operation).
        if (/^[A-Za-z_][\w.-]*=/.test(arg)) {
          parsed.kvPairs.push(arg);
        } else {
          parsed.positionals.push(arg);
        }
    }
  }
  return parsed;
}

/**
 * Resolve a tool from the positional tokens. Accepts either the full tool name
 * (`affiliate_awin_list_transactions`) or the friendly two-token network +
 * operation form (`awin list_transactions` / `awin listTransactions`).
 *
 * Returns the matched tool plus any positionals that were NOT consumed as the
 * tool selector (there should be none in practice, but we surface extras as an
 * error to the caller).
 */
function resolveTool(
  tools: ToolDefinition[],
  positionals: string[],
): { tool?: ToolDefinition; consumed: number } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const first = positionals[0];
  if (first === undefined) return { consumed: 0 };

  // Exact tool name.
  const direct = byName.get(first);
  if (direct) return { tool: direct, consumed: 1 };

  // <network> <operation> form. The generator abbreviates an over-length
  // `-advertiser` slug to `-adv` to stay within the 64-char MCP tool-name cap
  // (see toolNameFor in src/tools/generate.ts), so try both spellings: the
  // user types the real slug, but the registered name may carry `-adv`.
  const second = positionals[1];
  if (second !== undefined) {
    const snake = snakeOp(second);
    const candidates = [
      `affiliate_${first}_${snake}`.replace(/__+/g, '_'),
      `affiliate_${first.replace(/-advertiser$/, '-adv')}_${snake}`.replace(/__+/g, '_'),
    ];
    for (const candidate of candidates) {
      const composed = byName.get(candidate);
      if (composed) return { tool: composed, consumed: 2 };
    }
  }

  return { consumed: 0 };
}

/**
 * Coerce a raw `key=value` string to the type the tool's input schema declares
 * for `key`. The schema is the minimal JSON-Schema-ish projection from
 * `toJsonSchema` (properties carry `type`, or `oneOf` for unions). Anything the
 * schema doesn't describe falls back to a JSON-parse-or-string heuristic; the
 * downstream Zod parse remains the real validator either way.
 */
function coerceValue(raw: string, prop: Record<string, unknown> | undefined): unknown {
  const jsonOrString = (): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  if (!prop) return jsonOrString();

  switch (prop.type) {
    case 'string':
      // Keep the literal string: network ids are often numeric-looking.
      return raw;
    case 'number': {
      const n = Number(raw);
      // Leave the raw string if it isn't numeric so Zod reports it clearly.
      return Number.isNaN(n) ? raw : n;
    }
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return raw;
    case 'array': {
      const parsed = jsonOrString();
      if (Array.isArray(parsed)) return parsed;
      // Comma-separated convenience form, e.g. categories=fashion,beauty.
      return raw.split(',').map((s) => s.trim());
    }
    default:
      // Unions (oneOf, e.g. status: string | string[]): a JSON array wins,
      // a comma list becomes an array, otherwise it's a plain string.
      if (Array.isArray(prop.oneOf)) {
        const parsed = jsonOrString();
        if (Array.isArray(parsed)) return parsed;
        if (raw.includes(',')) return raw.split(',').map((s) => s.trim());
        return raw;
      }
      return jsonOrString();
  }
}

/** Merge `key=value` pairs and a `--args` JSON object into one argument record. */
function buildArgs(
  kvPairs: string[],
  jsonArgs: string | undefined,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  if (jsonArgs !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonArgs);
    } catch (e) {
      throw new Error(`--args is not valid JSON: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--args must be a JSON object, e.g. --args \'{"limit":50}\'');
    }
    Object.assign(args, parsed as Record<string, unknown>);
  }

  const properties = (inputSchema.properties as Record<string, Record<string, unknown>>) ?? {};
  for (const pair of kvPairs) {
    const eq = pair.indexOf('=');
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    args[key] = coerceValue(raw, properties[key]);
  }

  return args;
}

function printList(
  tools: ToolDefinition[],
  slugs: ReadonlySet<string>,
  networkFilter?: string,
): boolean {
  const filtered = networkFilter
    ? tools.filter((t) => networkOf(t.name, slugs) === networkFilter)
    : tools;

  if (filtered.length === 0) {
    err(
      networkFilter
        ? `No tools found for network "${networkFilter}". Run \`call --list\` to see all networks.`
        : 'No network adapters are registered, so no tools are available.',
    );
    return false;
  }

  // Group by network for a readable listing.
  const groups = new Map<string, ToolDefinition[]>();
  for (const t of filtered) {
    const net = networkOf(t.name, slugs);
    const bucket = groups.get(net) ?? [];
    bucket.push(t);
    groups.set(net, bucket);
  }

  const sortedNetworks = [...groups.keys()].sort((a, b) => {
    // Keep meta tools last; everything else alphabetical.
    if (a === 'meta') return 1;
    if (b === 'meta') return -1;
    return a.localeCompare(b);
  });

  for (const net of sortedNetworks) {
    out(`\n${net}`);
    const groupTools = (groups.get(net) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const t of groupTools) {
      // First sentence of the description is the WHAT line.
      const firstSentence = t.description.split('. ')[0];
      out(`  ${t.name}\n      ${firstSentence}.`);
    }
  }
  out('');
  return true;
}

function printDescribe(tool: ToolDefinition): void {
  out(tool.name);
  out('');
  out(tool.description);
  out('');
  out('Input schema:');
  out(JSON.stringify(tool.inputSchema, null, 2));
}

export interface CallOptions {
  argv: string[];
}

export async function runCall(opts: CallOptions): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parse(opts.argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  const tools = generateAllTools();
  const slugs = registeredSlugs();

  // `--list` (also the default when no tool is named) prints the catalogue.
  if (parsed.list || (parsed.positionals.length === 0 && !parsed.describe)) {
    return printList(tools, slugs, parsed.networkFilter) ? 0 : 2;
  }

  const { tool, consumed } = resolveTool(tools, parsed.positionals);

  if (!tool) {
    const target = parsed.positionals.join(' ');
    err(`No tool matches "${target}".`);
    err('Run `affiliate-networks-mcp call --list` to see available tools,');
    err('or use the `<network> <operation>` form, e.g. `call awin list_transactions`.');
    return 2;
  }

  // Any positionals beyond the tool selector are unexpected.
  const extras = parsed.positionals.slice(consumed);
  if (extras.length > 0) {
    err(`Unexpected extra argument(s): ${extras.join(' ')}`);
    err('Pass operation parameters as key=value pairs or via --args \'<json>\'.');
    return 2;
  }

  if (parsed.describe) {
    printDescribe(tool);
    return 0;
  }

  let args: Record<string, unknown>;
  try {
    args = buildArgs(parsed.kvPairs, parsed.jsonArgs, tool.inputSchema);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  // Entitlement gate: the same choke point the MCP server applies before it
  // runs a handler (`src/server.ts`), so `call` and the server behave
  // identically for the paid brand-data tools rather than the CLI being a way
  // around the gate. Dormant by default (isEntitled() returns true in v1); a
  // denied call surfaces the structured entitlement_required result on stderr
  // and exits non-zero — never faked into success (PRD principle 4.1).
  if (GATED_TOOLS.has(tool.name) && !isEntitled()) {
    err(JSON.stringify(buildEntitlementRequired(tool.name), null, 2));
    return 1;
  }

  try {
    const result = await tool.handle(args);
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    // Mirror the MCP server's failure routing: every failure surfaces as a
    // NetworkErrorEnvelope, never an opaque error (PRD principle 4.1).
    const envelope =
      e instanceof NetworkError
        ? e.envelope
        : isErrorEnvelope(e)
          ? e
          : toErrorEnvelope(e, { network: networkOf(tool.name, slugs), operation: tool.name });
    err(JSON.stringify(envelope, null, 2));
    return 1;
  }
}
