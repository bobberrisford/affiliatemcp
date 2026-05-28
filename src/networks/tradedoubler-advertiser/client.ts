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
 *   The API key is injected as a query parameter `key=<value>` on every
 *   request. Note: modern Tradedoubler REST APIs use `token=` but the legacy
 *   reports endpoint uses `key=` (confirmed by jongotlin/TradedoublerReportsWrapper
 *   and wp-plugins/affiliate-power).
 *   Tradedoubler returns HTTP 200 even for auth failures — an HTML login page
 *   or "Access Denied" response body is returned instead of XML. The client
 *   checks for this and throws an auth_error envelope when it detects it.
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
              'Check TRADEDOUBLER_ADV_TOKEN is the REPORTS-system API key ' +
              '(Account → Manage tokens in the Tradedoubler UI). ' +
              'The legacy reports endpoint uses key=, not token=.',
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
 * The confirmed XML structure (from denodell/tradedoubler mock data and
 * jongotlin/TradedoublerReportsWrapper Denormalizer.php) is:
 *
 *   <report name="aAffiliateMyProgramsReport" ...>
 *     <matrix rowcount="N">
 *       <columns>
 *         <siteName type="string">Publisher Site</siteName>
 *         <programName type="string">Programme Name</programName>
 *         ...
 *       </columns>
 *       <rows>
 *         <row>
 *           <siteName>One Digital Club</siteName>
 *           <programName>Amoma UK</programName>
 *           ...
 *         </row>
 *       </rows>
 *     </matrix>
 *   </report>
 *
 * Key points confirmed from community sources:
 *   - The column-definitions section is named `<columns>`, NOT `<columnDefs>`.
 *   - Row cells are NAMED elements (e.g. `<programId>12345</programId>`),
 *     NOT positional `<col>` elements.
 *   - The Denormalizer accesses values via `$row->programId` etc. (SimpleXML
 *     property access), confirming named-element structure.
 *   - For programmes, the data matrix is `matrix[1]` (index 1, not 0).
 *     The first matrix (`matrix[0]`) appears to be a summary/empty result.
 *
 * Sources:
 *   https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml
 *   https://github.com/jongotlin/TradedoublerReportsWrapper (Denormalizer.php)
 */
export function parseXmlMatrix(xml: string): TdAdvRow[] {
  // Extract the column names declared in the <columns> section.
  // Each direct child element of <columns> has the column name as its tag name.
  const columnNames = extractColumnNames(xml);

  // Extract each <row> block.
  const rowMatches = xml.matchAll(/<row>([\s\S]*?)<\/row>/g);
  const rows: TdAdvRow[] = [];

  for (const rowMatch of rowMatches) {
    const rowContent = rowMatch[1] ?? '';
    const row: TdAdvRow = {};

    if (columnNames.length > 0) {
      // Named-element format: extract each known column by its tag name.
      for (const colName of columnNames) {
        const re = new RegExp(`<${colName}[^>]*>([\\s\\S]*?)<\\/${colName}>`, 'i');
        const m = re.exec(rowContent);
        row[colName] = m ? (m[1] ?? '').trim() : '';
      }
    } else {
      // Fallback: extract all named child elements generically.
      // This handles responses where the <columns> section is absent or empty.
      const tagRe = /<([a-zA-Z][a-zA-Z0-9_]*)(?:[^>]*)?>([^<]*)<\/\1>/g;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(rowContent)) !== null) {
        const tagName = m[1];
        const value = m[2];
        if (tagName && tagName !== 'row' && value !== undefined) {
          row[tagName] = value.trim();
        }
      }
    }

    if (Object.keys(row).length > 0) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Extract column names from the `<columns>` section of a Tradedoubler
 * report XML response.
 *
 * In the confirmed Tradedoubler XML format each direct child element of
 * `<columns>` has the column identifier as its tag name:
 *
 *   <columns>
 *     <programId type="integer">Programme ID</programId>
 *     <programName type="string">Programme Name</programName>
 *   </columns>
 *
 * Sources:
 *   https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml
 */
function extractColumnNames(xml: string): string[] {
  // Find the <columns>...</columns> block.
  const colsMatch = /<columns>([\s\S]*?)<\/columns>/i.exec(xml);
  if (!colsMatch) return [];

  const colsContent = colsMatch[1] ?? '';
  const names: string[] = [];
  // Each child is <tagName ...>...</tagName>; extract the tag name.
  const tagRe = /<([a-zA-Z][a-zA-Z0-9_]*)(?:\s[^>]*)?\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(colsContent)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

export { HttpStatusError };
