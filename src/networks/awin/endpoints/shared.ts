import { requireCredential } from '../../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../../shared/errors.js';

export const AWIN_SLUG = 'awin';

export function requirePublisherId(operation: string): string {
  return requireCredential('AWIN_PUBLISHER_ID', {
    network: AWIN_SLUG,
    operation,
    hint:
      'Run `affiliate-networks-mcp setup awin` so the wizard can derive AWIN_PUBLISHER_ID ' +
      'from your token, or set it explicitly in ~/.affiliate-mcp/.env.',
  });
}

export function requireToken(operation: string): string {
  return requireCredential('AWIN_API_TOKEN', {
    network: AWIN_SLUG,
    operation,
    hint: 'Generate a token at the Awin publisher dashboard -> Account -> API credentials.',
  });
}

export function requirePositiveIntegerId(
  value: string | number,
  fieldName: string,
  operation: string,
): string {
  const id = String(value);
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: AWIN_SLUG,
        operation,
        message: `${fieldName} must be a positive integer; received "${id}".`,
        hint: 'Use the numeric Awin advertiser/publisher ID shown in the Awin dashboard or returned by list tools.',
      }),
    );
  }
  return id;
}

export function toDateOnly(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

export function defaultReportWindow(days = 30): { startDate: string; endDate: string } {
  const now = new Date();
  return {
    startDate: toDateOnly(undefined, new Date(now.getTime() - days * 24 * 60 * 60 * 1000)),
    endDate: toDateOnly(undefined, now),
  };
}

export function csv(values: Array<string | number> | undefined): string | undefined {
  return values && values.length > 0 ? values.map(String).join(',') : undefined;
}

export function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function toQuery(input: Record<string, unknown>): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = String(value);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map(String).join(',');
    }
  }
  return out;
}
