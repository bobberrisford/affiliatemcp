import { requireCredential } from '../../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../../shared/errors.js';

export const TD_SLUG = 'tradedoubler';

/**
 * Require the bearer token credential.
 *
 * Tradedoubler's connect.tradedoubler.com API uses OAuth2 bearer tokens.
 * The token is passed in the `Authorization: Bearer {token}` header.
 */
export function requireToken(operation: string): string {
  return requireCredential('TRADEDOUBLER_API_TOKEN', {
    network: TD_SLUG,
    operation,
    hint:
      'Generate an API token in the Tradedoubler dashboard → Account → Manage tokens. ' +
      'Set TRADEDOUBLER_API_TOKEN in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Require the organisation (publisher) ID credential.
 *
 * Tradedoubler's publisher API calls are scoped to an organisation. The
 * organisation ID appears in the Tradedoubler dashboard URL and in account
 * settings. It is a numeric string (e.g. "1234567").
 */
export function requireOrganizationId(operation: string): string {
  return requireCredential('TRADEDOUBLER_ORGANIZATION_ID', {
    network: TD_SLUG,
    operation,
    hint:
      'Your Tradedoubler organisation/publisher ID. Find it in the Tradedoubler dashboard URL ' +
      'after login (e.g. https://login.tradedoubler.com/home/{orgId}). ' +
      'Set TRADEDOUBLER_ORGANIZATION_ID in ~/.affiliate-mcp/.env.',
  });
}

export function configError(operation: string, message: string, hint?: string): NetworkError {
  return new NetworkError(
    buildErrorEnvelope({
      type: 'config_error',
      network: TD_SLUG,
      operation,
      message,
      hint,
    }),
  );
}

/**
 * Format a Date as YYYYMMDD, which Tradedoubler's connect API expects for
 * `fromDate`/`toDate` query parameters.
 */
export function formatTdDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Default report window helper — returns ISO dates for `from` and `to`
 * relative to now, used when the caller does not supply query.from/to.
 */
export function defaultWindow(days = 30): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}
