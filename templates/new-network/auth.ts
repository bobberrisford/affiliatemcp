/**
 * Template: auth helpers for <NETWORK_NAME>.
 *
 * Centralise credential loading + auth-header construction here so the rest of
 * the adapter does not handle raw secrets. All credential reads must go through
 * `requireCredential` from `src/shared/config.ts` so missing values surface as
 * `config_error` envelopes.
 *
 * Reference: src/networks/awin/auth.ts (bearer token, derivedValues pattern);
 *            src/networks/rakuten/auth.ts (OAuth2 client-credentials, token cache);
 *            src/networks/impact/auth.ts (HTTP Basic).
 *
 * What this file should export:
 *
 *   1. `verifyAuth()` — make a cheap, identity-revealing call to the network
 *      (Awin: /publishers; CJ: { me { ... } }; Impact: /Campaigns?PageSize=1).
 *      Return { ok: true, identity, derivedValues? } on success; on failure
 *      return { ok: false, reason, envelope } — never throw from verifyAuth,
 *      it is called by error handlers and throwing here loops.
 *
 *   2. `validateCredential(field, value)` — per-field validation called by
 *      the wizard. Return CredentialValidationResult. Format-validate cheap
 *      fields (IDs) without an API call; defer field validation when one
 *      credential requires another (e.g. OAuth2 client-id needs the secret).
 *
 *   3. For OAuth2 networks only: a `getAccessToken({ forceRefresh? })`
 *      function and an in-memory token cache. See Rakuten — the cache is
 *      the ONLY module-level mutable state allowed in an adapter folder,
 *      and the file should say so at the top.
 *
 *   4. `buildAuthHeaders(operation)` if the auth scheme is not a simple
 *      bearer token (Impact constructs Basic from base64(SID:Token)).
 *
 * API behaviour to verify:
 *   - What is the cheapest identity-revealing endpoint? Use it for verifyAuth.
 *   - Can the API derive a second credential for us? If yes, expose it via
 *     a `derivedValues` return on verifyAuth's success path so the wizard
 *     can persist it without asking the user (see Awin AWIN_PUBLISHER_ID).
 *   - For OAuth2: what is the token lifetime, what is the refresh strategy,
 *     and where do refresh failures surface?
 *
 * Error handling:
 *   Every failure path returns an envelope (or a structured result containing
 *   one). Never throw a bare Error from this file.
 */

// TODO: import { requireCredential } from '../../shared/config.js';
// TODO: import { buildErrorEnvelope } from '../../shared/errors.js';
// TODO: import type { CredentialValidationResult } from '../../shared/types.js';
// TODO: export async function verifyAuth(): Promise<...>
// TODO: export async function validateCredential(field: string, value: string): Promise<CredentialValidationResult>
// TODO: export function buildAuthHeaders(operation: string): Record<string, string>
export {};
