/**
 * Afilio HTTP client — the ONLY path Afilio adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, query
 *     building, response decoding, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Afilio API surface (verified against public documentation, 2026-06-04) ----
 *
 * Afilio is a Brazilian performance-marketing network. The publisher-facing
 * (affiliate) reporting APIs are simple GET endpoints that take the affiliate's
 * Token and Aff ID as query parameters and return XML. There is no OAuth flow;
 * the Token is self-issued from the dashboard (Login → "API token").
 *
 * Sales & Leads API (transactions):
 *   GET https://v2.afilio.com.br/api/leadsale_api.php
 *     ?mode=list&token={TOKEN}&affid={AFFID}&type=sale|lead
 *      &dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD&format=XML
 *   Source: https://v2.afilio.com.br/Manual/manuais-v2.html
 *           http://static.afilio.com.br/Manuais%202016/API_Sales_e_Leads_PT.pdf
 *
 * Campaign Description API (programmes):
 *   GET https://v2.afilio.com.br/api/{campaign endpoint}
 *     ?token={TOKEN}&affid={AFFID}&format=XML
 *   Documented fields: ID, Nome, URL, Descrição, Progdate, Progdeb, Progfin,
 *   SiteID, Cpmprice, Clicprice, Dblclicprice, Leadprice, Saleprice,
 *   Downloadprice, Status.
 *   Source: https://v2.afilio.com.br/Manual/manuais/api-campanhas.pdf
 *
 * BLOCKED(verify): the Afilio documentation PDFs are served behind a WAF that
 * returns HTTP 403 to automated clients, so the EXACT XML element names inside
 * each response, the EXACT campaign-description endpoint filename, and the full
 * set of status values could not be read verbatim. The names used in this
 * adapter were reconstructed from the published manual index and search-engine
 * snippets of the PDFs. The adapter therefore reads fields defensively (multiple
 * candidate names, all original data preserved under `rawNetworkData`) and the
 * network is shipped as `experimental` until confirmed against a live account.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('afilio.client');

const SLUG = 'afilio';

/**
 * The Afilio API base URL. Both reporting APIs live under `/api/`.
 * Source: https://v2.afilio.com.br/Manual/manuais-v2.html
 */
export const AFILIO_BASE_URL = 'https://v2.afilio.com.br';

/** Sales & Leads API endpoint path. */
export const AFILIO_LEADSALE_PATH = '/api/leadsale_api.php';

/**
 * Campaign Description API endpoint path.
 * BLOCKED(verify): the exact filename is not confirmed verbatim (PDF behind a
 * WAF). The published manual links to `manuais/api-campanhas.pdf`; the runtime
 * endpoint here mirrors the leadsale endpoint convention. Confirm against a live
 * account before promoting this network beyond `experimental`.
 */
export const AFILIO_CAMPAIGN_PATH = '/api/campaign_api.php';

export interface AfilioRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Afilio API request under the resilience policy and return the
 * raw response body (text). The Afilio reporting APIs return XML, so parsing is
 * handled by the caller via the `parseAfilioXml` helpers — this function keeps
 * the verbatim body intact for `rawNetworkData` and error envelopes.
 *
 * Why we return text and parse in the adapter rather than here: Afilio's XML
 * field set is reconstructed from documentation (the PDFs are WAF-blocked), so
 * we want every transformer to see the original structure and preserve it.
 */
export async function afilioRequest(input: AfilioRequestInput): Promise<string> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(AFILIO_BASE_URL, input.path, input.query);
      const init: RequestInit = {
        method: 'GET',
        headers: { Accept: 'application/xml, text/xml, */*' },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, operation: input.operation }, 'afilio request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Afilio ${input.operation} GET ${input.path} → HTTP ${res.status}`,
        );
      }

      // Afilio signals auth/parameter problems with a 200 + an <error> document
      // rather than an HTTP status in some cases. Detect the obvious error shape
      // so we surface it as an auth/network error rather than an empty result.
      const trimmed = rawBody.trim();
      if (/<error\b/i.test(trimmed) || /<erro\b/i.test(trimmed)) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Afilio ${input.operation} returned an error document.`,
            hint: 'Check AFILIO_AFFILIATE_TOKEN and AFILIO_AFF_ID are correct (Login → API token).',
          }),
        );
      }

      return rawBody;
    },
    input.resilience,
  );
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

// ---------------------------------------------------------------------------
// Minimal XML decoding
// ---------------------------------------------------------------------------
//
// Afilio returns flat XML: a list of <record>/<sale>/<lead>/<campaign> elements,
// each with simple leaf children (no attributes carrying data we need, no deep
// nesting). The project has no XML dependency (deps are limited to
// @modelcontextprotocol/sdk, pino, zod), so we implement a small, dependency-free
// parser sufficient for this flat shape. It is NOT a general-purpose XML parser:
//   - it extracts repeated row elements by tag name;
//   - within each row it collects leaf <tag>value</tag> pairs into a record;
//   - it decodes the five predefined XML entities + numeric entities.
//
// Anything we cannot model stays available verbatim because the adapter also
// keeps the original row substring on `rawNetworkData`.

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** A single parsed XML row: tag name → text value. */
export type AfilioXmlRow = Record<string, string>;

/**
 * Extract rows from an Afilio XML document.
 *
 * `rowTags` lists the candidate element names that wrap a single record (e.g.
 * `['sale', 'lead', 'record', 'item', 'row']`). The first tag that appears in
 * the document is used; all occurrences of it are returned as rows. Each row is
 * decoded into a flat `{ tag: value }` map (lower-cased tag names) plus a
 * `_raw` entry holding the verbatim row markup.
 */
export function parseAfilioXmlRows(xml: string, rowTags: string[]): AfilioXmlRow[] {
  for (const tag of rowTags) {
    const rowRe = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    const matches = [...xml.matchAll(rowRe)];
    if (matches.length === 0) continue;
    return matches.map((m) => {
      const inner = m[1] ?? '';
      const row: AfilioXmlRow = { _raw: m[0] ?? '' };
      const leafRe = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
      let leaf: RegExpExecArray | null;
      while ((leaf = leafRe.exec(inner)) !== null) {
        const name = (leaf[1] ?? '').toLowerCase();
        const value = decodeXmlEntities((leaf[2] ?? '').trim());
        // Skip nested containers (value still holds child tags): keep the first
        // scalar we find. The defensive field readers in the adapter tolerate
        // absent fields.
        if (!/<[A-Za-z_]/.test(value)) {
          row[name] = value;
        }
      }
      return row;
    });
  }
  return [];
}

export { HttpStatusError };

// Silence unused-import lint warning when noUnusedLocals is on.
void log;
