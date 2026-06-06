/**
 * GrowSurf auth + credential validation.
 *
 * GrowSurf uses a single API key sent as a bearer token
 * (`Authorization: Bearer <key>`). The API is campaign-scoped: most routes
 * embed a campaign id, so this adapter needs two credentials — the key and the
 * campaign id (`GROWSURF_CAMPAIGN_ID`). One key + campaign pair scopes one
 * programme, which is why this adapter is `single-brand`.
 *
 * No `derivedValues` flow: the key does not yield the campaign id, and a
 * GrowSurf account can hold several campaigns, so the user supplies the id
 * explicitly. `verifyAuth()` hits `GET /v2/campaign/:id` — the cheapest call
 * that returns 200 only when both the key and the campaign id are valid.
 * Reference: `src/networks/rewardful/auth.ts`.
 */

import { growsurfRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('growsurf.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

export function requireApiKey(operation: string): string {
  return requireCredential('GROWSURF_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Generate an API key in GrowSurf under Settings → Account → API, then set ' +
      'GROWSURF_API_KEY (or run `affiliate-networks-mcp setup growsurf`).',
  });
}

export function requireCampaignId(operation: string): string {
  return requireCredential('GROWSURF_CAMPAIGN_ID', {
    network: SLUG,
    operation,
    hint:
      'Find your campaign (programme) id in the GrowSurf dashboard URL after /campaign/, ' +
      'then set GROWSURF_CAMPAIGN_ID (or run `affiliate-networks-mcp setup growsurf`).',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let campaignId: string;
  try {
    apiKey = requireApiKey('verifyAuth');
    campaignId = requireCampaignId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await growsurfRequest<unknown>({
      operation: 'verifyAuth',
      path: `/campaign/${encodeURIComponent(campaignId)}`,
      apiKey,
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('growsurf verifyAuth succeeded');
    return { ok: true, identity: `growsurf/campaign:${campaignId}` };
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

export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'GROWSURF_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'GrowSurf API key is required.',
        hint: 'Generate one under Settings → Account → API in the GrowSurf dashboard.',
      };
    }
    // The key alone cannot be validated — verifyAuth needs the campaign id too.
    // Defer the live check to the campaign-id step.
    return {
      ok: true,
      message: 'API key recorded; it is verified together with the campaign id.',
    };
  }

  if (field === 'GROWSURF_CAMPAIGN_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'GrowSurf campaign (programme) id is required.',
        hint: 'Find it in the dashboard URL after /campaign/.',
      };
    }
    const prevKey = process.env['GROWSURF_API_KEY'];
    const prevId = process.env['GROWSURF_CAMPAIGN_ID'];
    process.env['GROWSURF_CAMPAIGN_ID'] = value;
    try {
      if (!prevKey || prevKey.trim() === '') {
        // No key yet — cannot verify live; accept the format and let verifyAuth
        // catch a mismatch once both are present.
        return {
          ok: true,
          message: 'Campaign id recorded; enter the API key to verify the pair.',
        };
      }
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'campaign verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check both the API key (Settings → Account → API) and the campaign id ' +
          '(in the dashboard URL after /campaign/).',
      };
    } finally {
      if (prevId === undefined) {
        delete process.env['GROWSURF_CAMPAIGN_ID'];
      } else {
        process.env['GROWSURF_CAMPAIGN_ID'] = prevId;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for GrowSurf.`,
    hint: 'GrowSurf expects GROWSURF_API_KEY and GROWSURF_CAMPAIGN_ID.',
  };
}
