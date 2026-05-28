/**
 * Tradedoubler advertiser HTTP client.
 *
 * Read-only at v0.1: the client refuses any non-GET method so the adapter
 * cannot accidentally ship a write operation.
 *
 * API surface used:
 *   reports.tradedoubler.com/pan/aReport3Key.action
 *     — the Tradedoubler report-generation endpoint used for both programme
 *       listing (aAffiliateMyProgramsReport) and event/conversion breakdown
 *       (aAffiliateEventBreakdownReport). The endpoint returns XML by default;
 *       we request format=XML and parse it with DOMParser (native in Node 18+)
 *       or via the xml2js-free lightweight parse approach.
 *
 * Authentication:
 *   Token is injected as a query parameter `token=<value>` on every request.
 *   Tradedoubler returns HTTP 200 even for auth failures — an HTML login page
 *   is returned instead of XML. The client checks for this and throws an
 *   auth_error envelope when it detects it.
 *
 * Response format:
 *   XML with a matrix/row/col structure. We parse it to a flat
 *   Record<string, string>[] using a lightweight parser.
 *
 * References (verified from public docs and community implementations):
 *   https://github.com/jongotlin/TradedoublerReportsWrapper
 *   https://github.com/wp-plugins/affiliate-power (apis/tradedoubler.php)
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { buildTokenUrl, isHtmlResponse, SLUG } from './auth.js';

const log = createLogger('tradedoubler-advertiser.client');

export const TD_REPORTS_BASE = 'https://reports.tradedoubler.com';

export interface TdAdvRequestInput {
  operation: AnyOperation;
  /** Query parameters (excluding token, which is injected automatically). */
  params: Record<string, string | number | undefined>;
  /** Method. Always GET at v0.1; passing anything else throws. */
  method?: 'GET';
  resilience: ResilienceConfig;
  token: string;
}

/**
 * Issue a single Tradedoubler report API request wrapped in the resilience policy.
 * Returns the parsed rows as Record<string, string>[].
 *
 * Cardinal: only GET is permitted. Any other method throws a config_error
 * before the network call goes out.
 */
export async function tdAdvRequest(input: TdAdvRequestInput): Promise<TdAdvRow[]> {
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Tradedoubler advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift ' +
          'this guard explicitly.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildTokenUrl(
        `${TD_REPORTS_BASE}/pan/aReport3Key.action`,
        input.token,
        input.params,
      );

      log.debug({ url, operation: input.operation }, 'tradedoubler-advertiser request');

      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/xml, text/xml' },
      });

      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Tradedoubler ${input.operation} GET → HTTP ${res.status}`,
        );
      }

      // Tradedoubler returns 200 + HTML login page on bad credentials.
      if (isHtmlResponse(rawBody)) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: 200,
            networkErrorBody: rawBody.slice(0, 500),
            message:
              'Tradedoubler returned HTML (login page) instead of XML — ' +
              'the API token was rejected.',
            hint:
              'Check TRADEDOUBLER_ADV_TOKEN is the REPORTS-system token ' +
              '(Account → Manage tokens in the Tradedoubler UI).',
          }),
        );
      }

      const trimmed = rawBody.trim();
      if (trimmed === '') {
        return [];
      }

      try {
        return parseXmlMatrix(rawBody);
      } catch (parseErr) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody.slice(0, 1000),
            message: `Tradedoubler ${input.operation} returned XML that could not be parsed: ${(parseErr as Error).message}`,
          }),
        );
      }
    },
    input.resilience,
  );
}

// ---------------------------------------------------------------------------
// XML response parsing
// ---------------------------------------------------------------------------

/** A parsed row from Tradedoubler's matrix-style XML response. */
export type TdAdvRow = Record<string, string>;

/**
 * Parse Tradedoubler's XML matrix response format into an array of flat row
 * objects keyed by column name.
 *
 * The XML structure is:
 *   <report>
 *     <matrix>
 *       <columnDefs>
 *         <columnDef id="programId" label="Programme ID" dataType="INTEGER" />
 *         ...
 *       </columnDefs>
 *       <rows>
 *         <row>
 *           <col>12345</col>
 *           <col>Acme</col>
 *           ...
 *         </row>
 *       </rows>
 *     </matrix>
 *   </report>
 *
 * Column ordering in <row><col> elements matches the order of <columnDef>
 * elements in <columnDefs>. We map by index.
 *
 * TODO(verify): confirm exact element nesting against a live account. The
 * structure was deduced from the community wrapper at
 * github.com/jongotlin/TradedoublerReportsWrapper.
 */
export function parseXmlMatrix(xml: string): TdAdvRow[] {
  // Extract all column IDs (attribute `id` on <columnDef> elements).
  const columnIds = extractColumnIds(xml);

  if (columnIds.length === 0) {
    // No column definitions — may be an empty result or a different envelope.
    return [];
  }

  // Extract each <row> block.
  const rowMatches = xml.matchAll(/<row>([\s\S]*?)<\/row>/g);
  const rows: TdAdvRow[] = [];

  for (const rowMatch of rowMatches) {
    const rowContent = rowMatch[1] ?? '';
    // Extract <col> values in order. Values may span multiple lines.
    const colMatches = [...rowContent.matchAll(/<col>([\s\S]*?)<\/col>/g)];
    const row: TdAdvRow = {};
    for (let i = 0; i < columnIds.length; i++) {
      const id = columnIds[i];
      if (id === undefined) continue;
      row[id] = (colMatches[i]?.[1] ?? '').trim();
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Extract column IDs from <columnDef id="..."> elements.
 * Also accepts <col id="..."> if the format differs.
 *
 * TODO(verify): confirm attribute name (`id` vs `name`) against a live response.
 */
function extractColumnIds(xml: string): string[] {
  const ids: string[] = [];
  // Try <columnDef id="..."> first.
  const defRe = /<columnDef[^>]+id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(xml)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  if (ids.length > 0) return ids;

  // Fallback: try <col id="..."> (alternative format in some Tradedoubler API versions).
  const colRe = /<col[^>]+id="([^"]+)"/g;
  while ((m = colRe.exec(xml)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

export { HttpStatusError };
