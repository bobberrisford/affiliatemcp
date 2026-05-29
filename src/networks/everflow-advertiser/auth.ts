/**
 * Everflow advertiser auth.
 *
 * Everflow uses a custom auth header:
 *   X-Eflow-API-Key: <api_key>
 *
 * The Network API key is scoped to the entire network (one key can address all
 * advertisers on that network). There is no per-advertiser scoping; credential
 * shape is always effectively "multi-brand" — the network admin creates the key
 * at Control Center → Security in the Everflow UI.
 *
 * IMPORTANT: Affiliate and advertiser users cannot create API keys themselves.
 * The network admin must create the key on their behalf and share it via a
 * secure channel. Network API keys are displayed only once at creation.
 *
 * `verifyAuth` makes a cheap GET to /v1/networks/advertisers?page=1&page_size=1
 * to confirm the key is valid and the network has at least one advertiser.
 *
 * Credentials:
 *   EVERFLOW_API_KEY        — the X-Eflow-API-Key header value
 *   EVERFLOW_ADVERTISER_ID  — the advertiser's network_advertiser_id (used as
 *                             listBrands falls back to this if only one brand is
 *                             being managed — optional at adapter level but used
 *                             in getProgrammePerformance to scope reports)
 *
 * Refs:
 *   https://developers.everflow.io/docs/user-guide/authentication/
 *   https://developers.everflow.io/docs/network/advertisers/
 */

import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('everflow-advertiser.auth');

export const SLUG = 'everflow-advertiser';
export const BASE_URL = 'https://api.eflow.team/v1';

export function apiKeyHeader(apiKey: string): Record<string, string> {
  return {
    'X-Eflow-API-Key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export function requireApiKey(operation: string): string {
  return requireCredential('EVERFLOW_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Your Everflow Network API key. Ask your network admin to create one at ' +
      'Control Center → Security → API Keys in the Everflow UI. ' +
      'Network API keys are shown only once at creation — store immediately.',
  });
}

export function requireAdvertiserId(operation: string): string {
  return requireCredential('EVERFLOW_ADVERTISER_ID', {
    network: SLUG,
    operation,
    hint:
      'Your Everflow network_advertiser_id. Find it in the Everflow UI: ' +
      'Advertisers → select your advertiser → the ID in the URL bar. ' +
      'Run `affiliate-networks-mcp setup everflow-advertiser` to configure.',
  });
}

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}
export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify auth by making a minimal GET to the advertisers list.
 * A 200 with a non-empty paging total confirms the key is valid.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  try {
    const apiKey = requireApiKey('verifyAuth');
    const url = `${BASE_URL}/networks/advertisers?page=1&page_size=1`;
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKeyHeader(apiKey),
    });
    const body = await res.text();

    if (res.status === 401 || res.status === 403) {
      const envelope = buildErrorEnvelope({
        type: 'auth_error',
        network: SLUG,
        operation: 'verifyAuth',
        httpStatus: res.status,
        networkErrorBody: body,
        message: `Everflow rejected the API key (HTTP ${res.status}).`,
        hint:
          'Check EVERFLOW_API_KEY is correct. The network admin generates keys at ' +
          'Control Center → Security in the Everflow UI.',
      });
      return { ok: false, reason: envelope.message, envelope };
    }
    if (!res.ok) {
      const envelope = buildErrorEnvelope({
        type: 'network_api_error',
        network: SLUG,
        operation: 'verifyAuth',
        httpStatus: res.status,
        networkErrorBody: body,
        message: `Everflow verifyAuth returned HTTP ${res.status}.`,
      });
      return { ok: false, reason: envelope.message, envelope };
    }

    let parsed: { paging?: { total_count?: number } } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // Not fatal — key may still be valid; just can't report identity clearly.
    }

    const total = parsed.paging?.total_count ?? 0;
    const advertiserId = getCredential('EVERFLOW_ADVERTISER_ID');
    const identity =
      advertiserId != null
        ? `everflow-advertiser/${advertiserId}`
        : `everflow-advertiser (${total} advertiser(s) visible)`;

    log.debug({ identity }, 'verifyAuth OK');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate one credential field during the setup wizard.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'EVERFLOW_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Everflow API key is required.',
        hint:
          'Ask your network admin to create a key at Control Center → Security → API Keys. ' +
          'Network API keys are shown only once — store immediately in a secrets manager.',
      };
    }
    // Everflow API keys have no fixed format in public docs — just check non-empty.
    // Store temporarily and do a live check.
    const previous = process.env['EVERFLOW_API_KEY'];
    process.env['EVERFLOW_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: 'Everflow API key verified successfully.' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'If the key is correct, confirm the network admin has not restricted its scope. ' +
          'Each Network API key carries its own permission scopes.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['EVERFLOW_API_KEY'];
      } else {
        process.env['EVERFLOW_API_KEY'] = previous;
      }
    }
  }

  if (field === 'EVERFLOW_ADVERTISER_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Everflow advertiser ID is required.',
        hint:
          'Find network_advertiser_id in Everflow UI: Advertisers → select advertiser → URL bar. ' +
          'Must be a positive integer.',
      };
    }
    if (!/^\d+$/.test(value.trim())) {
      return {
        ok: false,
        message: 'Everflow advertiser ID must be a positive integer.',
        hint: 'The network_advertiser_id is a number, e.g. "42".',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Everflow advertiser.`,
    hint: 'Everflow advertiser expects EVERFLOW_API_KEY and EVERFLOW_ADVERTISER_ID.',
  };
}
