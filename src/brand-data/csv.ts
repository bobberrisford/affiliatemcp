/**
 * Brand Data Layer — CSV serialisation for the paid export.
 *
 * Serialises the persisted 30-day rows to RFC-4180-ish CSV: fields containing a
 * comma, quote, or newline are wrapped in double quotes with embedded quotes
 * doubled. Columns are taken from the first row's keys, so callers pass rows of
 * a single, consistent shape (the store writes one shape per file).
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

function escapeField(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render rows as CSV with a header line. Returns '' for an empty input. */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0] ?? {});
  const header = columns.map(escapeField).join(',');
  const body = rows.map((row) => columns.map((col) => escapeField(row[col])).join(','));
  return [header, ...body].join('\n') + '\n';
}
