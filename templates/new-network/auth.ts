/**
 * Template: auth helpers for <NETWORK_NAME>.
 *
 * Centralise credential loading + auth-header construction here so the rest of
 * the adapter does not handle raw secrets. All credential reads must go through
 * `requireCredential` from `src/shared/config.ts` so missing values surface as
 * `config_error` envelopes.
 */

// TODO: import { requireCredential } from '../../src/shared/config.js';
// TODO: export function buildAuthHeaders(operation: string): Record<string, string> { ... }
export {};
