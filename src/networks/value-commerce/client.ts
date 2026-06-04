/**
 * ValueCommerce HTTP client — the ONLY path ValueCommerce adapter methods use for
 * network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, response parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - ValueCommerce uses two distinct call shapes: a token-acquisition request
 *     (returns JSON) and the data/report requests (default to XML). Both are
 *     centralised here.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- ValueCommerce API surface (verified against public docs, 2026-06-04) ------
 *
 * Token-acquisition API (affiliate side):
 *   GET https://api.valuecommerce.com/auth/v1/affiliate/token/?grant_type=client_credentials
 *     Header: Authorization: Bearer {signature}
 *       where signature = Base64( CLIENT_KEY + "|" + CLIENT_SECRET )
 *     → JSON: { access_token, token_type, expires_in } (token valid 30 minutes)
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/as-77-token-api/
 *           (mirror https://valuecommerce.github.io/pub-docs/docs/as-77-token-api.html)
 *
 * Order Report API (affiliate side):
 *   GET https://api.valuecommerce.com/report/v2/affiliate/transaction/
 *     Header: Authorization: Bearer {access_token}
 *     Params: limit (1-1000), offset, sort, field, criteria (a|c|o),
 *             from_date, to_date, approval_status (p|a|c|i)
 *     → XML by default (the affiliate endpoint is documented to return XML).
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/as-78-order-report-api/
 *
 * The "report API authentication key" (CLIENT_KEY + CLIENT_SECRET) is self-issued
 * from the management console: ［ツール］>［レポートAPI］> issue key, then
 * ［設定］>［レポートAPI認証キーの取得］.
 *   Source: https://help.valuecommerce.ne.jp/aff/tool/api/02/
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('value-commerce.client');

const SLUG = 'value-commerce';

/**
 * The ValueCommerce affiliate token-acquisition endpoint.
 * Source: https://pub-docs.valuecommerce.ne.jp/docs/as-77-token-api/
 */
export const VALUE_COMMERCE_TOKEN_URL =
  'https://api.valuecommerce.com/auth/v1/affiliate/token/';

/**
 * The ValueCommerce API base URL (token + report APIs share the host).
 * BLOCKED(verify): the order report API ships v1/v2/v3 endpoints; we target v2
 * as the documented current version. Confirm the preferred version against a
 * live account before promoting claim_status.
 * Source: https://pub-docs.valuecommerce.ne.jp/docs/as-78-order-report-api/
 */
export const VALUE_COMMERCE_BASE_URL = 'https://api.valuecommerce.com';

/** The affiliate order-report (transaction) path. */
export const VALUE_COMMERCE_TRANSACTION_PATH = '/report/v2/affiliate/transaction/';

export interface ValueCommerceRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Bearer access token from the token-acquisition API. */
  token: string;
  method?: 'GET' | 'POST';
  /** Query string parameters. Values that are `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL. */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * A parsed XML node. Attributes are not preserved separately — the report API
 * carries data in element text, not attributes, so we map element name → value
 * (string for leaf text, nested record for element children, array when an
 * element repeats). The verbatim XML string is always preserved on the domain
 * object's `rawNetworkData`, so this lossy-by-design tree is only ever used for
 * field extraction, never as the source of truth.
 */
export type XmlNode = string | { [key: string]: XmlNode | XmlNode[] };

/**
 * Issue a single ValueCommerce report-API request under the resilience policy.
 *
 * The affiliate order-report API returns XML by default, so we send
 * `Accept: application/xml` and parse the body into a generic node tree. We do
 * NOT validate the shape with Zod: ValueCommerce element names can vary across
 * report versions, so reading defensively and preserving the raw XML string is
 * more robust than a schema that breaks on drift.
 */
export async function valueCommerceRequest(
  input: ValueCommerceRequestInput,
): Promise<{ tree: XmlNode; rawXml: string }> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? VALUE_COMMERCE_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(base, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${input.token}`,
          // The affiliate order-report API defaults to XML; be explicit so an
          // intermediary cannot negotiate us into an unexpected format.
          Accept: 'application/xml',
        },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'value-commerce request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `ValueCommerce ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return { tree: {}, rawXml: '' };
      }

      try {
        return { tree: parseXml(rawBody), rawXml: rawBody };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message:
              `ValueCommerce ${input.operation} returned HTTP ${res.status} with a body that ` +
              `could not be parsed as XML (parse error: ${(err as Error).message}).`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Fetch a ValueCommerce affiliate access token.
 *
 * GET https://api.valuecommerce.com/auth/v1/affiliate/token/?grant_type=client_credentials
 *   Header: Authorization: Bearer {Base64(CLIENT_KEY|CLIENT_SECRET)}
 *   Response (JSON): { access_token, token_type, expires_in }
 *
 * Why the signature is Base64(CLIENT_KEY|CLIENT_SECRET): ValueCommerce documents
 * the affiliate token request as a Bearer header whose value is the API
 * authentication key pair joined with a pipe and Base64-encoded.
 *   Source: https://pub-docs.valuecommerce.ne.jp/docs/as-77-token-api/
 *           https://help.valuecommerce.ne.jp/aff/tool/api/02/
 *
 * This function is called only from auth.ts (the token cache). Adapter operations
 * use the cached token via `getAccessToken()`.
 */
export async function fetchAccessToken(
  clientKey: string,
  clientSecret: string,
  resilience: ResilienceConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: SLUG, operation: 'fetchAccessToken' };

  return withResilience(
    ctx,
    async () => {
      const signature = Buffer.from(`${clientKey}|${clientSecret}`, 'utf8').toString('base64');
      const url = `${VALUE_COMMERCE_TOKEN_URL}?grant_type=client_credentials`;

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${signature}`,
          Accept: 'application/json',
        },
      });

      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `ValueCommerce token acquisition → HTTP ${res.status}`,
        );
      }

      let parsed: { access_token?: string; expires_in?: number };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'ValueCommerce token endpoint returned a non-JSON body.',
            hint: 'Check VALUE_COMMERCE_CLIENT_KEY and VALUE_COMMERCE_CLIENT_SECRET are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'ValueCommerce token endpoint returned a response with no access_token field.',
            hint: 'Verify VALUE_COMMERCE_CLIENT_KEY and VALUE_COMMERCE_CLIENT_SECRET are correct.',
          }),
        );
      }

      // ValueCommerce tokens are valid for 30 minutes (1800s). We subtract a 60s
      // buffer so we refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 1800;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'value-commerce access token fetched');
      return { accessToken: parsed.access_token, expiresAt };
    },
    resilience,
  );
}

// ---------------------------------------------------------------------------
// Minimal XML parsing
// ---------------------------------------------------------------------------
//
// Why a hand-rolled parser instead of a dependency: the project's dependency set
// is intentionally tiny (@modelcontextprotocol/sdk, pino, zod) and adding an XML
// library is out of scope for a single adapter. ValueCommerce's order-report XML
// is a flat list of <Transaction> elements with leaf text fields, so a small,
// well-scoped parser handles it. The verbatim XML string is preserved on every
// domain object's `rawNetworkData`, so any field this parser cannot reach is
// still recoverable by the caller.
//
// BLOCKED(verify): the exact element names (root, repeated transaction element,
// per-field tags) are NOT confirmed from public snippets — only the request
// parameters and status codes are. The adapter therefore reads a set of
// candidate tag names defensively. Confirm the real element names against a live
// account before promoting claim_status.

/**
 * Parse an XML document into a generic node tree.
 *
 * Supported: elements, nested elements, repeated sibling elements (collapsed to
 * arrays), text content, CDATA, self-closing tags, the XML declaration, and
 * comments. Attributes are intentionally ignored (the report API carries data in
 * element text). Throws on a structurally broken document so the client can
 * surface a parse error rather than silently returning a half-tree.
 */
export function parseXml(xml: string): XmlNode {
  // Strip the XML declaration, comments, and DOCTYPE.
  const cleaned = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();

  const tokens = tokeniseXml(cleaned);
  let pos = 0;

  function parseChildren(): { children: Record<string, XmlNode | XmlNode[]>; text: string } {
    const children: Record<string, XmlNode | XmlNode[]> = {};
    let text = '';
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (!tok || tok.kind === 'close') {
        break;
      }
      if (tok.kind === 'text') {
        text += tok.value;
        pos += 1;
        continue;
      }
      // tok.kind === 'open' or 'selfclose'
      const node = parseElement();
      addChild(children, node.name, node.value);
    }
    return { children, text };
  }

  function parseElement(): { name: string; value: XmlNode } {
    const tok = tokens[pos];
    if (!tok) {
      throw new Error('unexpected end of XML while parsing an element');
    }
    if (tok.kind === 'selfclose') {
      pos += 1;
      return { name: tok.name, value: '' };
    }
    // open
    pos += 1; // consume the open tag
    const { children, text } = parseChildren();
    const closeTok = tokens[pos];
    if (!closeTok || closeTok.kind !== 'close' || closeTok.name !== tok.name) {
      throw new Error(`unbalanced XML: expected </${tok.name}>`);
    }
    pos += 1; // consume the close tag
    const keys = Object.keys(children);
    if (keys.length === 0) {
      return { name: tok.name, value: decodeEntities(text.trim()) };
    }
    return { name: tok.name, value: children };
  }

  const { children } = parseChildren();
  return children as XmlNode;
}

interface XmlToken {
  kind: 'open' | 'close' | 'selfclose' | 'text';
  name: string;
  value: string;
}

function tokeniseXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const re = /<\/?([A-Za-z_][\w.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const [full, name, _attrs, selfClose, textChunk] = m;
    if (textChunk !== undefined) {
      // Decode CDATA pass-through; entity decoding happens at leaf assignment.
      const cdata = textChunk.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      tokens.push({ kind: 'text', name: '', value: cdata });
      continue;
    }
    // `name` is captured by the tag branch of the regex; default defensively.
    const tagName = name ?? '';
    if (full.startsWith('</')) {
      tokens.push({ kind: 'close', name: tagName, value: '' });
    } else if (selfClose === '/') {
      tokens.push({ kind: 'selfclose', name: tagName, value: '' });
    } else {
      tokens.push({ kind: 'open', name: tagName, value: '' });
    }
  }
  return tokens;
}

function addChild(
  children: Record<string, XmlNode | XmlNode[]>,
  name: string,
  value: XmlNode,
): void {
  const existing = children[name];
  if (existing === undefined) {
    children[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    children[name] = [existing, value];
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function buildUrl(
  base: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
