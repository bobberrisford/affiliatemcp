/**
 * Optimise Media (OMG Network API) auth + credential validation.
 *
 * The OMG Network API authenticates with a single secret — an `apikey` minted
 * by creating a Service Account in the Insights Dashboard. There is no OAuth
 * refresh flow: we treat the key as a static secret loaded from
 * `OPTIMISE_MEDIA_API_TOKEN`. If Optimise moves to rotating keys, this is the
 * only file that needs to change.
 *
 * Reference: src/networks/everflow/auth.ts (custom API-key header) and
 * src/networks/awin/auth.ts (the verifyAuth + validateCredential pattern).
 *
 * The cheap, identity-revealing call is the Campaigns endpoint with a small
 * page: it is authenticated (rejects a bad key) and confirms the publisher has
 * a working relationship surface, without pulling the whole catalogue.
 *
 * Never throw a bare Error from this file — verifyAuth is called by error
 * handlers, so throwing here loops. Every failure path returns a structured
 * result carrying an envelope.
 */

import { optimiseMediaRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('optimise-media.auth');

const SLUG = 'optimise-media';

/**
 * The minimal shape we read off the Campaigns response for identity. Optimise
 * returns a paged envelope of campaign rows; we do not over-specify it (see
 * client.ts for the rationale). Field names that vary across tenants are read
 * defensively.
 */
interface OptimiseCampaignRow {
  campaignId?: number | string;
  CampaignId?: number | string;
  campaignName?: string;
  CampaignName?: string;
  name?: string;
}

interface OptimiseCampaignsEnvelope {
  data?: OptimiseCampaignRow[];
  items?: OptimiseCampaignRow[];
  results?: OptimiseCampaignRow[];
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
 * Read the configured `apikey`. Surfaces a `config_error` envelope (via
 * `requireCredential`) when the key is missing.
 */
export function requireApiKey(operation: string): string {
  return requireCredential('OPTIMISE_MEDIA_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Create a Service Account in the Optimise Insights Dashboard to generate an API key, ' +
      'then set OPTIMISE_MEDIA_API_TOKEN in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Verify the API key with a cheap Campaigns call.
 *
 * Why this endpoint: it is the smallest authenticated call on the publisher
 * surface — it rejects a bad key (401/403) and confirms the credential can
 * read the publisher's campaign relationships. We request a single page so the
 * latency stays low for the interactive wizard.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await optimiseMediaRequest<OptimiseCampaignsEnvelope | OptimiseCampaignRow[]>({
      operation: 'verifyAuth',
      path: '/Campaigns',
      apiKey,
      query: { page: 1, pageSize: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const rows = normaliseCampaigns(response);
    log.debug({ count: rows.length }, 'optimise-media verifyAuth succeeded');

    return {
      ok: true,
      identity:
        rows.length > 0
          ? `optimise-media (${rows.length}+ campaign relationship(s) visible)`
          : 'optimise-media (no campaign relationships on this key)',
    };
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

function normaliseCampaigns(
  response: OptimiseCampaignsEnvelope | OptimiseCampaignRow[],
): OptimiseCampaignRow[] {
  if (Array.isArray(response)) return response;
  return response.data ?? response.items ?? response.results ?? [];
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * `OPTIMISE_MEDIA_API_TOKEN` requires a live call. We write the candidate into
 * `process.env`, run `verifyAuth()`, then restore the previous value so a
 * failed validation does not poison subsequent operations in the same process
 * (test isolation).
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'OPTIMISE_MEDIA_API_TOKEN') {
    const previous = process.env['OPTIMISE_MEDIA_API_TOKEN'];
    process.env['OPTIMISE_MEDIA_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key in the Optimise Insights Dashboard → Service Accounts. ' +
          'It may be revoked, lack the required scope, or have been copied with stray whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['OPTIMISE_MEDIA_API_TOKEN'];
      } else {
        process.env['OPTIMISE_MEDIA_API_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Optimise Media.`,
    hint: 'Optimise Media expects OPTIMISE_MEDIA_API_TOKEN (the Service Account API key).',
  };
}
