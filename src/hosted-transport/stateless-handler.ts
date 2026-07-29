/**
 * MCP 2026-07-28 stateless request handler
 * (`docs/decisions/2026-07-29-mcp-2026-07-28-early-adoption.md`).
 *
 * A pure per-request JSON-RPC protocol layer: no SDK `Server` instance, no
 * transport object, no session map. Every request is self-contained (SEP-2575)
 * and carries its protocol context in `params._meta`; routing metadata rides
 * in the `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` HTTP headers (SEP-2243). The
 * wire contract implemented here is the one the official conformance suite
 * (`@modelcontextprotocol/conformance`, pinned in package.json) tests:
 *
 * - gate order: missing `MCP-Protocol-Version` header (-32020) -> missing
 *   required `_meta` keys (-32602) -> header/_meta version mismatch (-32020)
 *   -> unsupported version (-32022, `data.supported`/`data.requested`); all
 *   HTTP 400;
 * - `Mcp-Method` must be present and match the body method (case-sensitive,
 *   OWS-trimmed); `Mcp-Name` must be present and match `params.name`/`params.uri`
 *   whenever the body carries one; mismatches are HTTP 400 with -32020;
 * - `server/discover` returns `supportedVersions`, `capabilities`, and
 *   identifies the server via `_meta['io.modelcontextprotocol/serverInfo']`;
 * - removed lifecycle methods (`initialize`, `ping`, `logging/setLevel`,
 *   `resources/subscribe|unsubscribe`) and unknown methods are HTTP 404 with
 *   -32601, preserving the request id;
 * - a tool whose definition names required client capabilities is refused with
 *   -32021 (HTTP 400) when `_meta` client capabilities lack them, with
 *   `error.data.requiredCapabilities` as a ClientCapabilities OBJECT;
 * - results carry `resultType: "complete"`, and the read-only core methods
 *   additionally carry `ttlMs`/`cacheScope` caching hints (SEP-2549).
 *
 * The surface (which tools and prompts exist, and what calling them does) is
 * a constructor argument: production wires the shared hosted pipeline
 * (`stateless-surface.ts`); the conformance harness adds the suite's
 * diagnostic fixtures (`conformance-fixtures.ts`). The protocol behaviour
 * certified by the suite is this file, identical in both.
 */

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const STATELESS_PROTOCOL_VERSION = '2026-07-28';

const REQUIRED_META_KEYS = [META_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES] as const;

/** Read-only core methods that carry caching hints on their results (SEP-2549). */
const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

/** Methods that carry a name/uri the `Mcp-Name` header must mirror (SEP-2243). */
function expectedMcpName(method: string, params: Record<string, unknown>): string | undefined {
  if (method === 'tools/call' || method === 'prompts/get') {
    return typeof params['name'] === 'string' ? (params['name'] as string) : undefined;
  }
  if (method === 'resources/read') {
    return typeof params['uri'] === 'string' ? (params['uri'] as string) : undefined;
  }
  return undefined;
}

export interface StatelessCallContext {
  /** The client's declared capabilities from `_meta` — what -32021 enforcement reads. */
  clientCapabilities: Record<string, unknown>;
  /** The request's full `_meta` (progress tokens and other per-request context). */
  meta: Record<string, unknown>;
  /** Queue a JSON-RPC notification (e.g. `notifications/progress`) onto the
   * response stream, ahead of the final result frame. On the stateless path
   * notifications never travel out of band; they ride the same response. */
  notify: (method: string, params: Record<string, unknown>) => void;
}

/** One tool on the stateless surface. `requiredClientCapabilities` names the
 * client capabilities the tool cannot run without (-32021 when undeclared);
 * production affiliate tools require none. */
export interface StatelessToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  requiredClientCapabilities?: string[];
  call: (
    args: Record<string, unknown>,
    ctx: StatelessCallContext,
  ) => Promise<Record<string, unknown>>;
}

export interface StatelessSurface {
  serverInfo: { name: string; version: string };
  tools: StatelessToolDefinition[];
  prompts: {
    list: () => unknown[];
    /** Throws when the prompt is unknown or its arguments are invalid. */
    get: (name: string, args: Record<string, string>) => Record<string, unknown>;
  };
  /** Optional resource surface. The production server has none (absent);
   * the conformance fixtures provide one. `read` returns `null` for a URI
   * matching no resource, which the handler maps to the SEP-2164 error. */
  resources?: {
    list: () => unknown[];
    templates: () => unknown[];
    read: (uri: string) => Record<string, unknown> | null;
  };
  /** Optional completion provider (`completion/complete`). Absent means the
   * honest empty answer: no suggestions for any argument. */
  complete?: (
    ref: Record<string, unknown>,
    argument: { name: string; value: string },
  ) => { values: string[]; total?: number; hasMore?: boolean };
}

export interface StatelessResponse {
  status: number;
  body: Record<string, unknown>;
  /** When present, the response is a text/event-stream: these JSON-RPC
   * notification frames precede the final `body` frame, in order. */
  notifications?: Array<Record<string, unknown>>;
}

type JsonRpcId = string | number | null;

function reject(id: JsonRpcId, status: number, code: number, message: string, data?: unknown): StatelessResponse {
  return {
    status,
    body: {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    },
  };
}

function firstHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  // RFC 9110 §5.5: optional whitespace around field values is not part of the
  // value — trim before any comparison.
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * Routing predicate for `http-server.ts`: a request takes the stateless path
 * when it declares the stateless protocol revision or carries the stateless
 * routing header. Anything else (legacy `initialize` bodies, sessionful
 * requests with `mcp-session-id`, pre-2026 protocol version headers) stays on
 * the legacy path untouched. The `Mcp-Method`-less-but-2026-version case MUST
 * still route here: SEP-2243 requires the missing-header rejection to come
 * from the stateless validator, not a legacy session error.
 */
export function isStatelessRequest(headers: Record<string, string | string[] | undefined>): boolean {
  if (firstHeader(headers, 'mcp-method') !== undefined) return true;
  return firstHeader(headers, 'mcp-protocol-version') === STATELESS_PROTOCOL_VERSION;
}

/** Strict Base64 for `=?base64?...?=` Mcp-Param values: canonical alphabet,
 * correct padding, length a multiple of four. Node's decoder is lenient, so
 * validate before decoding (SEP-2243 requires rejecting bad padding/characters). */
function decodeStrictBase64(encoded: string): string | null {
  if (encoded.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const padIndex = encoded.indexOf('=');
  if (padIndex !== -1 && padIndex < encoded.length - 2) return null;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

interface McpParamOutcome {
  ok: boolean;
  message?: string;
  /** Decoded header values keyed by argument property name, for injection. */
  values?: Record<string, string>;
}

/**
 * SEP-2243 custom `Mcp-Param-*` header validation for one tool call. For every
 * inputSchema property annotated `x-mcp-header`, the value travels in the
 * `Mcp-Param-<header>` header: the header must be present whenever the body
 * carries the argument, `=?base64?...?=`-wrapped values must be valid Base64,
 * unwrapped values are literal, and the (decoded) header value must match the
 * body argument when both are present. Production tools carry no
 * `x-mcp-header` annotations, so this is inert for them.
 */
function validateMcpParams(
  tool: StatelessToolDefinition,
  args: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): McpParamOutcome {
  const properties = (tool.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!properties) return { ok: true };
  const values: Record<string, string> = {};
  for (const [propName, prop] of Object.entries(properties)) {
    const headerSuffix = prop['x-mcp-header'];
    if (typeof headerSuffix !== 'string') continue;
    const headerValue = firstHeader(headers, `mcp-param-${headerSuffix.toLowerCase()}`);
    const bodyValue = args[propName];
    if (headerValue === undefined) {
      if (bodyValue !== undefined) {
        return {
          ok: false,
          message: `Missing Mcp-Param-${headerSuffix} header for parameter "${propName}" present in the request body`,
        };
      }
      continue;
    }
    let decoded = headerValue;
    const wrapped = /^=\?base64\?(.*)\?=$/s.exec(headerValue);
    if (wrapped) {
      const inner = decodeStrictBase64(wrapped[1] as string);
      if (inner === null) {
        return {
          ok: false,
          message: `Invalid Base64 in Mcp-Param-${headerSuffix} header value`,
        };
      }
      decoded = inner;
    }
    if (bodyValue !== undefined && decoded !== String(bodyValue)) {
      return {
        ok: false,
        message: `Mcp-Param-${headerSuffix} header value does not match the "${propName}" argument in the request body`,
      };
    }
    values[propName] = decoded;
  }
  return { ok: true, values };
}

/** Attach `resultType` (SEP-2322) and, on read-only core methods, the
 * `ttlMs`/`cacheScope` caching hints (SEP-2549). */
function decorateResult(method: string, result: Record<string, unknown>): Record<string, unknown> {
  const decorated: Record<string, unknown> = { resultType: 'complete', ...result };
  if (CACHEABLE_METHODS.has(method)) {
    decorated['ttlMs'] ??= 0;
    decorated['cacheScope'] ??= 'private';
  }
  return decorated;
}

function ok(id: JsonRpcId, method: string, result: Record<string, unknown>): StatelessResponse {
  return {
    status: 200,
    body: { jsonrpc: '2.0', id, result: decorateResult(method, result) },
  };
}

/** Build the ClientCapabilities-shaped object -32021 responses carry in
 * `error.data.requiredCapabilities` (an object keyed by capability, never an
 * array of names). */
function requiredCapabilitiesObject(names: string[]): Record<string, Record<string, never>> {
  const out: Record<string, Record<string, never>> = {};
  for (const name of names) out[name] = {};
  return out;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** DNS-rebinding protection (MCP transport security requirements, and the
 * `dns-rebinding-protection` conformance scenario): when a browser-set
 * `Origin` header is present, its host must be a localhost form or one of the
 * explicitly allowed hosts (the transport's own public host in production).
 * Requests without an `Origin` header (server-to-server MCP clients) pass. */
function originAllowed(headers: Record<string, string | string[] | undefined>, allowedHosts: string[]): boolean {
  const origin = firstHeader(headers, 'origin');
  // `Origin: null` (sandboxed iframes, some redirects) is allowed for the same
  // reason a missing Origin is: this check only guards against the browser
  // DNS-rebinding shape, and every request here has ALREADY passed bearer
  // verification, which a rebinding page cannot forge. Rejecting `null` would
  // add no protection and break legitimate non-browser clients that send it.
  if (origin === undefined || origin === 'null') return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return LOCALHOST_HOSTS.has(host) || allowedHosts.includes(host);
}

export interface StatelessRequestOptions {
  /** Extra `Origin` hosts to allow beside the localhost forms — in production,
   * the transport's own public host (`config.resourceUrl`). */
  allowedOriginHosts?: string[];
}

/**
 * Handle one parsed stateless request. Pure: reads only its arguments,
 * returns the HTTP status and JSON-RPC body to send. Authentication has
 * already happened in `http-server.ts` (per-request bearer verification is
 * unchanged between the two paths).
 */
export async function handleStatelessRequest(
  surface: StatelessSurface,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  options?: StatelessRequestOptions,
): Promise<StatelessResponse> {
  if (!originAllowed(headers, options?.allowedOriginHosts ?? [])) {
    return reject(null, 403, -32600, 'Origin not allowed');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reject(null, 400, -32600, 'Invalid Request: expected a JSON-RPC request object');
  }
  const request = body as Record<string, unknown>;
  const id: JsonRpcId =
    typeof request['id'] === 'string' || typeof request['id'] === 'number' ? (request['id'] as string | number) : null;
  const method = typeof request['method'] === 'string' ? (request['method'] as string) : '';
  const params =
    typeof request['params'] === 'object' && request['params'] !== null
      ? (request['params'] as Record<string, unknown>)
      : {};
  const meta =
    typeof params['_meta'] === 'object' && params['_meta'] !== null
      ? (params['_meta'] as Record<string, unknown>)
      : undefined;

  // Gate 1 (SEP-2575): the protocol version header is mandatory on every
  // stateless request.
  const headerVersion = firstHeader(headers, 'mcp-protocol-version');
  if (headerVersion === undefined) {
    return reject(id, 400, -32020, 'Missing MCP-Protocol-Version header');
  }

  // Gate 2: structural `_meta` requirements. `clientInfo` is deliberately NOT
  // required (a SHOULD since spec PR #3002 — servers MUST NOT require it).
  const missingMetaKeys = REQUIRED_META_KEYS.filter((key) => meta?.[key] === undefined);
  if (missingMetaKeys.length > 0) {
    return reject(id, 400, -32602, `Invalid params: missing _meta keys: ${missingMetaKeys.join(', ')}`);
  }

  // Gate 3: the header and `_meta` must agree on the version.
  if (meta?.[META_PROTOCOL_VERSION] !== headerVersion) {
    return reject(id, 400, -32020, 'MCP-Protocol-Version header does not match _meta.protocolVersion');
  }

  // Gate 4: the agreed version must be one this path implements.
  if (headerVersion !== STATELESS_PROTOCOL_VERSION) {
    return reject(id, 400, -32022, 'Unsupported protocol version', {
      supported: [STATELESS_PROTOCOL_VERSION],
      requested: headerVersion,
    });
  }

  // SEP-2243 standard header validation: `Mcp-Method` must be present and
  // match the body method exactly (values are case-sensitive; surrounding
  // whitespace is not part of the value).
  const mcpMethod = firstHeader(headers, 'mcp-method');
  if (mcpMethod === undefined) {
    return reject(id, 400, -32020, 'Missing Mcp-Method header');
  }
  if (mcpMethod !== method) {
    return reject(id, 400, -32020, `Mcp-Method header "${mcpMethod}" does not match body method "${method}"`);
  }
  const nameInBody = expectedMcpName(method, params);
  if (nameInBody !== undefined) {
    const mcpName = firstHeader(headers, 'mcp-name');
    if (mcpName === undefined) {
      return reject(id, 400, -32020, 'Missing Mcp-Name header');
    }
    if (mcpName !== nameInBody) {
      return reject(id, 400, -32020, `Mcp-Name header "${mcpName}" does not match the request body`);
    }
  }

  const clientCapabilities =
    typeof meta?.[META_CLIENT_CAPABILITIES] === 'object' && meta[META_CLIENT_CAPABILITIES] !== null
      ? (meta[META_CLIENT_CAPABILITIES] as Record<string, unknown>)
      : {};

  switch (method) {
    case 'server/discover':
      return ok(id, method, {
        supportedVersions: [STATELESS_PROTOCOL_VERSION],
        capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
        _meta: { [META_SERVER_INFO]: { name: surface.serverInfo.name, version: surface.serverInfo.version } },
      });

    case 'tools/list':
      return ok(id, method, {
        tools: surface.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });

    case 'tools/call': {
      const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      const args =
        typeof params['arguments'] === 'object' && params['arguments'] !== null
          ? { ...(params['arguments'] as Record<string, unknown>) }
          : {};
      const tool = surface.tools.find((t) => t.name === name);
      if (!tool) {
        // Mirror the hosted legacy path: an unknown tool is a tool-level
        // error result, not a protocol error — the caller asked a well-formed
        // question about a tool that does not exist.
        return ok(id, method, {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'unknown_tool', message: `No tool named "${name}" is registered.` }, null, 2),
            },
          ],
        });
      }
      const required = tool.requiredClientCapabilities ?? [];
      const missing = required.filter((cap) => clientCapabilities[cap] === undefined);
      if (missing.length > 0) {
        return reject(
          id,
          400,
          -32021,
          `Missing required client capabilities: ${missing.join(', ')}`,
          { requiredCapabilities: requiredCapabilitiesObject(missing) },
        );
      }
      const paramOutcome = validateMcpParams(tool, args, headers);
      if (!paramOutcome.ok) {
        return reject(id, 400, -32020, paramOutcome.message as string);
      }
      if (paramOutcome.values) Object.assign(args, paramOutcome.values);
      const notifications: Array<Record<string, unknown>> = [];
      const result = await tool.call(args, {
        clientCapabilities,
        meta: meta ?? {},
        notify: (notifyMethod, notifyParams) =>
          notifications.push({ jsonrpc: '2.0', method: notifyMethod, params: notifyParams }),
      });
      const response = ok(id, method, result);
      return notifications.length > 0 ? { ...response, notifications } : response;
    }

    case 'prompts/list':
      return ok(id, method, { prompts: surface.prompts.list() });

    case 'prompts/get': {
      const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      const args =
        typeof params['arguments'] === 'object' && params['arguments'] !== null
          ? (params['arguments'] as Record<string, string>)
          : {};
      try {
        return ok(id, method, surface.prompts.get(name, args));
      } catch (err) {
        return reject(id, 400, -32602, err instanceof Error ? err.message : String(err));
      }
    }

    // The production hosted server has no resources, so absent a surface
    // provider the empty lists are the honest answer and let the SEP-2549
    // caching scenario exercise the hints without inventing content.
    case 'resources/list':
      return ok(id, method, { resources: surface.resources?.list() ?? [] });

    case 'resources/templates/list':
      return ok(id, method, { resourceTemplates: surface.resources?.templates() ?? [] });

    case 'resources/read': {
      const uri = typeof params['uri'] === 'string' ? (params['uri'] as string) : '';
      const contents = surface.resources?.read(uri) ?? null;
      if (contents) return ok(id, method, contents);
      // SEP-2164: a URI that matches no resource MUST NOT yield an empty
      // `contents` result; it is an Invalid Params error naming the URI.
      return reject(id, 400, -32602, 'Resource not found', { uri });
    }

    case 'completion/complete': {
      const ref =
        typeof params['ref'] === 'object' && params['ref'] !== null ? (params['ref'] as Record<string, unknown>) : {};
      const rawArgument =
        typeof params['argument'] === 'object' && params['argument'] !== null
          ? (params['argument'] as Record<string, unknown>)
          : {};
      const argument = {
        name: typeof rawArgument['name'] === 'string' ? (rawArgument['name'] as string) : '',
        value: typeof rawArgument['value'] === 'string' ? (rawArgument['value'] as string) : '',
      };
      const completion = surface.complete?.(ref, argument) ?? { values: [], hasMore: false };
      return ok(id, method, { completion: { hasMore: false, ...completion } });
    }

    default:
      // Removed lifecycle methods (`initialize`, `ping`, `logging/setLevel`,
      // `resources/subscribe|unsubscribe`), `subscriptions/listen` (no
      // subscription-delivered capability is advertised), and anything
      // unknown: SEP-2575 maps "no such RPC method" to HTTP 404 with the
      // JSON-RPC -32601 signature, preserving the request id.
      return reject(id, 404, -32601, `Method not found: ${method}`);
  }
}
