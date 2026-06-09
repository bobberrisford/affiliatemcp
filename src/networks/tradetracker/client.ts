/**
 * TradeTracker SOAP client — the ONLY path TradeTracker adapter methods use for
 * network I/O.
 *
 * TradeTracker (NL/EU affiliate network) exposes a SOAP Web Service for
 * affiliates at `https://ws.tradetracker.com/soap/affiliate` (WSDL at
 * `?wsdl`). There is no REST or JSON surface for the affiliate side, so this
 * client builds SOAP request envelopes by hand (template strings) and parses
 * the XML responses with a minimal built-in parser. No XML dependency is added
 * — this mirrors `src/networks/cake/client.ts`, which hand-parses ASP.NET
 * `.asmx` XML the same way (read that file for the parser rationale).
 *
 * --- Auth / session ---------------------------------------------------------
 *
 * SOAP `authenticate(customerID, passphrase, sandbox, locale, demo)` opens a
 * server-side session and returns a `Set-Cookie` header (PHP-style session id,
 * e.g. `PHPSESSID=...; path=/`). Every subsequent call MUST replay that cookie
 * on the `Cookie` request header or the server rejects it as unauthenticated.
 * The session cookie is cached in `auth.ts` and re-established on expiry; this
 * client simply accepts a `cookie` to send and surfaces any `Set-Cookie`
 * returned so the auth layer can refresh its cache.
 *
 * Hard rules (mirrored from Awin/CAKE/Everflow client.ts — read those for the
 * full rationale):
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
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tradetracker.client');

export const SLUG = 'tradetracker';

/**
 * The TradeTracker affiliate SOAP endpoint. Centralised so a test harness can
 * point at a mock without touching adapter code. Hard-coded for v0.1.
 */
export const TRADETRACKER_BASE_URL = 'https://ws.tradetracker.com';
export const TRADETRACKER_SOAP_PATH = '/soap/affiliate';

/**
 * The SOAP target namespace for the TradeTracker affiliate service. The body
 * method element is qualified with this namespace (`tns:`); the parameters
 * themselves are unqualified, matching the WSDL.
 */
export const TRADETRACKER_NAMESPACE = 'https://ws.tradetracker.com/soap/affiliate';

export interface TradeTrackerRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** The SOAP method name to invoke, e.g. `authenticate`, `getCampaigns`. */
  method: string;
  /** Pre-rendered SOAP body inner-XML for the method (parameters). */
  bodyXml: string;
  /** Session cookie to replay (from a prior authenticate). Omitted for authenticate itself. */
  cookie?: string;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

export interface TradeTrackerResponse {
  /** Parsed XML element tree of the SOAP envelope. */
  root: TtElement;
  /** Raw `Set-Cookie` header value, if the server issued a new session cookie. */
  setCookie?: string;
}

/**
 * Issue a single TradeTracker SOAP request under the resilience policy.
 *
 * The full SOAP envelope is assembled here so the adapter only supplies the
 * method name and parameter XML. On success the parsed envelope is returned
 * along with any `Set-Cookie` so the auth layer can cache/refresh the session.
 */
export async function tradeTrackerRequest(
  input: TradeTrackerRequestInput,
): Promise<TradeTrackerResponse> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = `${TRADETRACKER_BASE_URL}${TRADETRACKER_SOAP_PATH}`;
      const envelope = buildEnvelope(input.method, input.bodyXml);

      const headers: Record<string, string> = {
        'Content-Type': 'text/xml; charset=utf-8',
        // SOAPAction is required by some SOAP stacks; TradeTracker accepts an
        // empty action but we send the method name to be explicit.
        SOAPAction: `"${input.method}"`,
        Accept: 'text/xml, application/soap+xml',
      };
      if (input.cookie) {
        headers['Cookie'] = input.cookie;
      }

      const init: RequestInit = {
        method: 'POST',
        headers,
        body: envelope,
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      // Never log credentials or the session cookie. Log the SOAP method only.
      log.debug({ method: input.method, operation: input.operation }, 'tradetracker request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (parse XML) and for
      // failure (surface the raw text on the envelope). SOAP faults arrive as a
      // 500 with a <soap:Fault> body, so the raw text is the actionable detail.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `TradeTracker ${input.operation} POST ${TRADETRACKER_SOAP_PATH} (${input.method}) → HTTP ${res.status}`,
        );
      }

      let root: TtElement;
      try {
        root = parseXml(rawBody);
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `TradeTracker ${input.operation} returned HTTP ${res.status} with unparseable XML (parse error: ${(err as Error).message})`,
          }),
        );
      }

      // A SOAP Fault can arrive with a 200 in some stacks. Detect it and surface
      // the verbatim fault string rather than letting the transformer read an
      // empty result and report "no data" (principle 4.1).
      const fault = findFirst(root, 'Fault');
      if (fault) {
        const faultString =
          childText(fault, 'faultstring') ?? childText(fault, 'Reason') ?? rawBody;
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `TradeTracker ${input.operation} returned a SOAP fault: ${faultString}`,
          }),
        );
      }

      const setCookie = res.headers.get('set-cookie') ?? undefined;
      return setCookie ? { root, setCookie } : { root };
    },
    input.resilience,
  );
}

/**
 * Assemble a full SOAP 1.1 envelope for `method` with the given parameter XML.
 *
 * The body method element is namespace-qualified (`tns:`) against the
 * TradeTracker target namespace; parameters are unqualified children, which is
 * what the affiliate WSDL expects.
 */
export function buildEnvelope(method: string, bodyXml: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope ' +
    'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    `xmlns:tns="${TRADETRACKER_NAMESPACE}">` +
    '<soap:Body>' +
    `<tns:${method}>${bodyXml}</tns:${method}>` +
    '</soap:Body>' +
    '</soap:Envelope>'
  );
}

/**
 * Escape a value for safe inclusion in XML element text. Hand-built envelopes
 * carry user-controlled values (passphrase, destination URLs); without escaping
 * a `&` or `<` would corrupt the request.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Minimal XML parser
// ---------------------------------------------------------------------------
//
// TradeTracker SOAP responses are XML. We cannot add an XML dependency (no new
// deps allowed), so this is a deliberately small parser handling the
// element/attribute/text subset SOAP emits:
//   - elements with attributes and nested children
//   - text content
//   - self-closing tags
//   - <?xml ...?> prologue and <!-- comments -->
//   - <![CDATA[...]]> sections
// It is NOT a general XML parser. Transformers read fields defensively, so a
// field the parser misses simply becomes `undefined` rather than an error.
// This mirrors `src/networks/cake/client.ts` — the same approach, no new dep.
// ---------------------------------------------------------------------------

export interface TtElement {
  /** Local tag name (namespace prefix stripped). */
  name: string;
  /** Attribute map (decoded values). */
  attrs: Record<string, string>;
  /** Child elements in document order. */
  children: TtElement[];
  /** Concatenated direct text content, trimmed. */
  text: string;
}

/** Find the first descendant (depth-first) whose local name matches. */
export function findFirst(el: TtElement, name: string): TtElement | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    const nested = findFirst(c, name);
    if (nested) return nested;
  }
  return undefined;
}

/** Collect all descendants whose local name matches (depth-first order). */
export function findAll(el: TtElement, name: string): TtElement[] {
  const out: TtElement[] = [];
  const walk = (node: TtElement): void => {
    for (const c of node.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/**
 * Direct children whose local name matches. Unlike `findAll`, this does not
 * descend into matched elements — used to iterate a repeated row element
 * without picking up nested duplicates.
 */
export function childrenNamed(el: TtElement, name: string): TtElement[] {
  return el.children.filter((c) => c.name === name);
}

/** Read the trimmed text of the first matching child element, or undefined. */
export function childText(el: TtElement, name: string): string | undefined {
  for (const c of el.children) {
    if (c.name === name) {
      const t = c.text.trim();
      return t === '' ? undefined : t;
    }
  }
  return undefined;
}

/** The first matching child element, or undefined. */
export function child(el: TtElement, name: string): TtElement | undefined {
  return el.children.find((c) => c.name === name);
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
 * Parse a SOAP XML document into a single root `TtElement`. Throws on a
 * document with no element nodes.
 */
export function parseXml(xml: string): TtElement {
  // Pull CDATA content out verbatim before stripping comments etc., re-encoding
  // its markup so the regex tokeniser treats it as text rather than elements.
  const withCdata = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) =>
    inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );

  // Strip prologue, comments, and DOCTYPE.
  const s = withCdata
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const root: TtElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: TtElement[] = [root];
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

    const el: TtElement = { name, attrs: parseAttrs(rawAttrs ?? ''), children: [], text: '' };
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
