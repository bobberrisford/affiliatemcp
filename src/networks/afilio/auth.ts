/**
 * Afilio auth + credential validation.
 *
 * Afilio's publisher (affiliate) APIs do not use OAuth or bearer tokens. Every
 * request carries two query parameters:
 *
 *   - token  — the Affiliate Token, self-issued from the dashboard
 *              (Login → "API token").
 *   - affid  — the numeric Affiliate ID.
 *
 * There is therefore no token-exchange step and no token cache: the credentials
 * are sent verbatim on each call by `client.ts`. `auth_model` is `custom`.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth makes one cheap Sales API call over a one-day window. A 2xx XML
 * response (even an empty list) proves the Token + Aff ID are accepted; an
 * <error> document or a 4xx proves they are not. It never throws — verifyAuth is
 * called by error handlers.
 */

import { afilioRequest, AFILIO_LEADSALE_PATH } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('afilio.auth');

const SLUG = 'afilio';

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/** Read the affiliate token, throwing a config_error envelope if unset. */
export function requireToken(operation: string): string {
  return requireCredential('AFILIO_AFFILIATE_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Set AFILIO_AFFILIATE_TOKEN in ~/.affiliate-mcp/.env. ' +
      'Find it in the Afilio dashboard under Login → "API token".',
  });
}

/** Read the affiliate ID, throwing a config_error envelope if unset. */
export function requireAffId(operation: string): string {
  return requireCredential('AFILIO_AFF_ID', {
    network: SLUG,
    operation,
    hint:
      'Set AFILIO_AFF_ID in ~/.affiliate-mcp/.env. ' +
      'This is your numeric Affiliate ID, shown in the Afilio dashboard.',
  });
}

/**
 * Verify Afilio credentials with one cheap Sales API call over a one-day window.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  let affid: string;
  try {
    token = requireToken('verifyAuth');
    affid = requireAffId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  // A one-day window keeps the probe cheap. Anchor on a fixed recent day rather
  // than "today" only matters for live calls; the window itself is irrelevant to
  // the auth check, which is about whether token + affid are accepted at all.
  const day = new Date().toISOString().slice(0, 10);

  try {
    await afilioRequest({
      operation: 'verifyAuth',
      path: AFILIO_LEADSALE_PATH,
      query: {
        mode: 'list',
        token,
        affid,
        type: 'sale',
        dateStart: day,
        dateEnd: day,
        format: 'XML',
      },
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `afilio/affid:${affid}`;
    log.debug({ identity }, 'afilio verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Check AFILIO_AFFILIATE_TOKEN and AFILIO_AFF_ID in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * AFILIO_AFFILIATE_TOKEN: performs a live Sales API probe with whatever
 * AFILIO_AFF_ID is currently set (or the one entered earlier in the wizard).
 * If the Aff ID is not yet set, falls back to a non-empty format check.
 *
 * AFILIO_AFF_ID: format check (positive integer) — no API call needed on its own.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AFILIO_AFFILIATE_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Affiliate Token must not be empty.',
        hint: 'Copy the token from the Afilio dashboard under Login → "API token".',
      };
    }
    // We can only do a live probe if the Aff ID is already known.
    if (!getCredential('AFILIO_AFF_ID')) {
      return {
        ok: true,
        message: 'Token format OK; will validate against the API once the Aff ID is entered.',
      };
    }
    const prevToken = process.env['AFILIO_AFFILIATE_TOKEN'];
    process.env['AFILIO_AFFILIATE_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the Afilio Sales API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check AFILIO_AFFILIATE_TOKEN and AFILIO_AFF_ID. Both must match the values in the Afilio dashboard.',
      };
    } finally {
      if (prevToken === undefined) {
        delete process.env['AFILIO_AFFILIATE_TOKEN'];
      } else {
        process.env['AFILIO_AFFILIATE_TOKEN'] = prevToken;
      }
    }
  }

  if (field === 'AFILIO_AFF_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Afilio Aff ID must be a positive integer.',
        hint: 'Find your numeric Affiliate ID in the Afilio dashboard.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Afilio.`,
    hint: 'Afilio expects AFILIO_AFFILIATE_TOKEN and AFILIO_AFF_ID.',
  };
}
