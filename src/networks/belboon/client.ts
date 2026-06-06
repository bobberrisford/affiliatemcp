/**
 * Belboon HTTP client — the ONLY path Belboon adapter methods use for network I/O.
 *
 * Belboon's publisher API is the Ingenious Technologies "export file" interface
 * (Belboon runs on the Ingenious platform). It differs from Awin/Everflow in two
 * load-bearing ways, so read this header before editing:
 *
 *   1. AUTH IS IN THE URL, NOT A HEADER. Each request embeds the account's
 *      "Magic Key" (a UUID) as the first path segment and the numeric user/
 *      partner id inside the export-file name. There is no Authorization header.
 *      See `buildExportUrl`.
 *
 *   2. RESPONSES ARE CSV (or XLS/XML), NOT JSON. The export endpoints serve
 *      delimited files, not a JSON API. This client requests the `.csv`
 *      variant and parses it into an array of row objects keyed by the header
 *      row. JSON is not offered by the platform.
 *      (Verified against the public FAQ + strackr/affiliate-toolkit examples,
 *      2026-06-05; the exact column set is dashboard-gated and unverified
 *      against a live account — see adapter.ts known limitations.)
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('belboon.client');

/**
 * Belboon / Ingenious export host.
 *
 * The export host is PER-ACCOUNT on the Ingenious platform: public examples
 * show both `https://export.net.<tenant>` and
 * `https://export-demonet.ingenioustech.biz`. We default to the documented
 * Belboon production host and let the operator override it via
 * `BELBOON_EXPORT_HOST` for tenants served from a different subdomain.
 *
 * UNVERIFIED against a live account — see adapter.ts known limitations.
 */
export const BELBOON_BASE_URL = 'https://export.net.belboon.com';

export function resolveExportHost(): string {
  const override = process.env['BELBOON_EXPORT_HOST'];
  if (override && override.trim() !== '') {
    const trimmed = override.trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  return BELBOON_BASE_URL;
}

/** One parsed export row: header column → cell value (both strings). */
export type BelboonRow = Record<string, string>;

export interface BelboonRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** The Ingenious export name, e.g. `adm-conversionexport`, `adm-merchantexport`, `statsdaily`. */
  exportName: string;
  /** The account Magic Key (UUID). Embedded as the first path segment. */
  magicKey: string;
  /** The numeric user/partner id. Embedded in the export-file name. */
  userId: string;
  /**
   * Filter parameters. Belboon expects `filter[<name>]=<value>` query keys
   * (e.g. `filter[from_date]=01.06.2014`). Pass the inner name (`from_date`)
   * as the key; this client wraps it in `filter[...]`. Plain keys (no wrapping)
   * are passed through verbatim — used for non-filter params like `products`.
   */
  filters?: Record<string, string | number | undefined>;
  /** Non-filter query params passed verbatim (e.g. `{ products: 'true' }`). */
  params?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Belboon export request under the resilience policy and return
 * the parsed CSV rows.
 *
 * The raw text body is preserved verbatim on failure via `HttpStatusError`.
 */
export async function belboonRequest(input: BelboonRequestInput): Promise<BelboonRow[]> {
  const ctx: WithResilienceContext = { network: 'belboon', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildExportUrl(input);
      const init: RequestInit = { method: 'GET' };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url: redactUrl(url), operation: input.operation }, 'belboon request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (parse CSV) and for
      // failure (surface the raw text on the envelope). Ingenious error bodies
      // are plain text or HTML, not CSV.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Belboon ${input.operation} GET ${input.exportName} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return [];
      }

      return parseCsv(rawBody);
    },
    input.resilience,
  );
}

/**
 * Compose the Ingenious export URL.
 *
 * Format (verified shape, dashboard-gated specifics unverified):
 *   https://<host>/<magicKey>/<exportName>_<userId>.csv?filter[from_date]=...
 *
 * Examples from public docs (2026-06-05):
 *   .../<key>/adm-conversionexport_123.csv?filter[from_date]=01.06.2014
 *   .../<key>/adm-merchantexport_288.csv?products=true
 *   .../<key>/statsdaily_2209.csv?filter[a:advertiser]=123
 */
export function buildExportUrl(input: BelboonRequestInput): string {
  const host = resolveExportHost();
  const file = `${input.exportName}_${input.userId}.csv`;
  const url = new URL(`/${encodeURIComponent(input.magicKey)}/${file}`, host);

  if (input.filters) {
    for (const [k, v] of Object.entries(input.filters)) {
      if (v === undefined) continue;
      url.searchParams.set(`filter[${k}]`, String(v));
    }
  }
  if (input.params) {
    for (const [k, v] of Object.entries(input.params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Redact the magic key from a URL before logging. The key is a credential; it
 * must never reach the logs (PRD: credentials never leave the machine, and the
 * logger is stderr-only but still must not carry secrets).
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/');
    if (segments.length > 1 && segments[1]) segments[1] = '***';
    u.pathname = segments.join('/');
    return u.toString();
  } catch {
    return '***';
  }
}

/**
 * Parse a Belboon CSV export into row objects.
 *
 * Defensive by design — the column set is dashboard-gated and unverified, so we
 * never assume specific headers here. We:
 *   - sniff the delimiter (`;` vs `,` vs tab) from the header line. Ingenious
 *     CSV exports are commonly semicolon-delimited (German locale), but the
 *     delimiter is configurable per export, so we detect rather than assume.
 *   - support double-quoted fields with embedded delimiters and escaped quotes.
 *   - key each data row by the trimmed header names.
 *
 * Rows with a different cell count than the header are still returned, padded
 * or truncated against the header, so a malformed line never throws — the
 * adapter transformer reads keys defensively and the raw row is preserved.
 */
export function parseCsv(text: string): BelboonRow[] {
  const records = tokeniseCsv(text);
  if (records.length === 0) return [];

  const header = records[0] ?? [];
  const delimiterless = header.length === 0;
  if (delimiterless) return [];

  const headers = header.map((h) => h.trim());
  const rows: BelboonRow[] = [];

  for (let i = 1; i < records.length; i++) {
    const cells = records[i] ?? [];
    // Skip fully empty trailing lines.
    if (cells.length === 1 && cells[0]?.trim() === '') continue;
    const row: BelboonRow = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      row[key] = (cells[c] ?? '').trim();
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Tokenise CSV text into an array of records (each an array of cells).
 *
 * Handles quoted fields, embedded delimiters/newlines inside quotes, and
 * doubled `""` escapes. The delimiter is sniffed from the first line.
 */
function tokeniseCsv(text: string): string[][] {
  const normalised = text.replace(/^\uFEFF/, ''); // strip BOM
  const firstLineEnd = normalised.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? normalised : normalised.slice(0, firstLineEnd);
  const delimiter = sniffDelimiter(firstLine);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i];

    if (inQuotes) {
      if (ch === '"') {
        if (normalised[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      continue;
    }
    if (ch === '\r') {
      // Swallow CR; the following LF closes the record.
      continue;
    }
    field += ch;
  }

  // Flush the final field/record if the file did not end with a newline.
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

/**
 * Sniff the CSV delimiter from the header line. Prefers semicolon (the common
 * Ingenious/German-locale default), then tab, then comma. Falls back to comma.
 */
function sniffDelimiter(headerLine: string): string {
  const counts: Array<[string, number]> = [
    [';', occurrences(headerLine, ';')],
    ['\t', occurrences(headerLine, '\t')],
    [',', occurrences(headerLine, ',')],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const [best, count] = counts[0] ?? [',', 0];
  return count > 0 ? best : ',';
}

function occurrences(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly. The boundary stays clean: "everything network
// goes through ./client".
export { HttpStatusError };
