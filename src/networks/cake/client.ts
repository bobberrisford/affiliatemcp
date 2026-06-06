/**
 * CAKE HTTP client — the ONLY path CAKE adapter methods use for network I/O.
 *
 * CAKE (getcake) is a per-instance affiliate platform engine. Every CAKE-powered
 * network runs on its own host (e.g. `https://network.example.com`), so the base
 * URL is a CREDENTIAL, not a fixed constant — it is read from `CAKE_BASE_URL`.
 * This is the "multiplier base-URL" pattern: one parameterised adapter serves
 * every CAKE instance.
 *
 * --- Auth -------------------------------------------------------------------
 *
 * CAKE authenticates with an Affiliate API Key passed as the `api_key` QUERY
 * parameter (not a header). The affiliate id is passed as `affiliate_id`.
 * Confirmed via support.getcake.com OfferFeed (V4) / Conversions affiliate docs:
 *   .../affiliates/api/4/offers.asmx/OfferFeed?api_key=...&affiliate_id=...
 *
 * --- Response format --------------------------------------------------------
 *
 * The CAKE affiliate API is built on classic ASP.NET `.asmx` web services and
 * returns XML, not JSON. We do not pull in an XML dependency (no new deps
 * allowed); instead the transformers in `adapter.ts` read fields from the
 * parsed element tree produced by `parseXml` below. The parser is intentionally
 * minimal: it handles the element/attribute/text subset CAKE emits and is not a
 * general-purpose XML parser.
 *
 * Hard rules (mirrored from Everflow/Awin client.ts — read those for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential } from '../../shared/config.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('cake.client');

export const SLUG = 'cake';

export interface CakeRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the per-instance base URL. */
  path: string;
  /** Affiliate API key. Passed in from auth helpers. Sent as the `api_key` query param. */
  apiKey: string;
  method?: 'GET' | 'POST';
  /** Query string parameters. Values with `undefined` are skipped. `api_key` is added here. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Read and validate the per-instance CAKE base URL from `CAKE_BASE_URL`.
 *
 * This is the credential that makes one adapter serve every CAKE network. It
 * must be an absolute http(s) URL pointing at the affiliate's CAKE host. We
 * validate it eagerly so a malformed value surfaces as an actionable
 * `config_error` rather than an opaque fetch failure.
 */
export function requireBaseUrl(operation: string): string {
  const raw = requireCredential('CAKE_BASE_URL', {
    network: SLUG,
    operation,
    hint:
      'Set CAKE_BASE_URL to your CAKE instance host (the domain you log in to, ' +
      'e.g. https://your-network.cakemarketing.com). It is shown in the affiliate ' +
      'portal under the Reporting API panel.',
  });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `CAKE_BASE_URL is not a valid URL: "${raw}".`,
        hint: 'Use the full host including scheme, e.g. https://your-network.cakemarketing.com.',
      }),
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `CAKE_BASE_URL must be an http(s) URL; received protocol "${parsed.protocol}".`,
        hint: 'Use the full host including scheme, e.g. https://your-network.cakemarketing.com.',
      }),
    );
  }
  // Normalise to the origin — CAKE paths are absolute (/affiliates/api/...).
  return parsed.origin;
}

/**
 * Issue a single CAKE API request under the resilience policy.
 *
 * Auth: CAKE uses `api_key` as a query parameter. The key is passed in from the
 * adapter so credential reads happen once per operation in the adapter, not deep
 * inside the HTTP layer. The base URL is read from the credential here.
 *
 * Returns the parsed XML element tree (see `parseXml`). CAKE affiliate responses
 * are always XML; on an empty body we return an empty element.
 */
export async function cakeRequest(input: CakeRequestInput): Promise<CakeElement> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const baseUrl = requireBaseUrl(input.operation);

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(baseUrl, input.path, { ...input.query, api_key: input.apiKey });
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: { Accept: 'application/xml, text/xml' },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      // Never log the api_key. Log the path + operation only.
      log.debug({ path: input.path, method: init.method, operation: input.operation }, 'cake request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (parse XML) and for
      // failure (surface the raw text on the envelope). CAKE error bodies are
      // typically XML-shaped but may be plain text on gateway errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `CAKE ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return emptyElement();
      }

      try {
        return parseXml(rawBody);
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `CAKE ${input.operation} returned HTTP ${res.status} with unparseable XML (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 */
function buildUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Minimal XML parser
// ---------------------------------------------------------------------------
//
// CAKE affiliate `.asmx` endpoints return XML. We cannot add an XML dependency
// (no new deps allowed), so this is a deliberately small parser that handles
// the element/attribute/text subset CAKE emits:
//   - elements with attributes and nested children
//   - text content
//   - self-closing tags
//   - <?xml ...?> prologue and <!-- comments -->
// It is NOT a general XML parser (no DTDs, no namespaces beyond treating
// `xmlns:*` as attributes). Transformers read fields defensively, so a field
// the parser misses simply becomes `undefined` rather than an error.
// ---------------------------------------------------------------------------

export interface CakeElement {
  /** Local tag name (namespace prefix stripped). */
  name: string;
  /** Attribute map (decoded values). */
  attrs: Record<string, string>;
  /** Child elements in document order. */
  children: CakeElement[];
  /** Concatenated direct text content, trimmed. */
  text: string;
}

function emptyElement(): CakeElement {
  return { name: '', attrs: {}, children: [], text: '' };
}

/** Find the first descendant (depth-first) whose local name matches. */
export function findFirst(el: CakeElement, name: string): CakeElement | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    const nested = findFirst(c, name);
    if (nested) return nested;
  }
  return undefined;
}

/** Collect all descendants whose local name matches (depth-first order). */
export function findAll(el: CakeElement, name: string): CakeElement[] {
  const out: CakeElement[] = [];
  const walk = (node: CakeElement): void => {
    for (const c of node.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** Read the trimmed text of the first matching child element, or undefined. */
export function childText(el: CakeElement, name: string): string | undefined {
  for (const c of el.children) {
    if (c.name === name) {
      const t = c.text.trim();
      return t === '' ? undefined : t;
    }
  }
  return undefined;
}

function stripPrefix(tag: string): string {
  const i = tag.indexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    // Ampersand last so it doesn't double-decode the entities above.
    .replace(/&amp;/g, '&');
}

/**
 * Parse a CAKE XML document into a single root `CakeElement`. Throws on a
 * document with no element nodes.
 */
export function parseXml(xml: string): CakeElement {
  // Strip prologue, comments, and DOCTYPE.
  const s = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const root: CakeElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: CakeElement[] = [root];
  const tagRe = /<\s*(\/?)\s*([a-zA-Z_][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)\s*(\/?)\s*>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(s)) !== null) {
    const closing = match[1];
    const rawName = match[2];
    const rawAttrs = match[3];
    const selfClose = match[4];

    // Text between the previous tag and this one belongs to the current parent.
    const between = s.slice(lastIndex, match.index);
    if (between.trim() !== '') {
      const parent = stack[stack.length - 1];
      if (parent) parent.text += decodeEntities(between).trim();
    }
    lastIndex = tagRe.lastIndex;

    const name = stripPrefix(rawName ?? '');

    if (closing === '/') {
      // Close the nearest matching open element.
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]?.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el: CakeElement = { name, attrs: parseAttrs(rawAttrs ?? ''), children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    if (selfClose !== '/') {
      stack.push(el);
    }
  }

  const first = root.children[0];
  if (!first) {
    throw new Error('no XML element nodes found');
  }
  return first;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw)) !== null) {
    const key = stripPrefix(m[1] ?? '');
    const val = m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
