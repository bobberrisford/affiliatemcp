/**
 * Amazon Creators API adapter (publisher side).
 *
 * Amazon Creators API is the successor to the Product Advertising API
 * (PA-API 5.0). PA-API deprecates on 30 April 2026 and the endpoint retires on
 * 15 May 2026; new integrations target the Creators API. See the file header in
 * `client.ts` for the auth model and the host/path reconstruction.
 *
 * --- What the Creators API actually exposes ---------------------------------
 *
 * The Creators API is a PRODUCT-CATALOG API: getItems / searchItems /
 * getVariations / getBrowseNodes. It does NOT expose any reporting surface —
 * there is no earnings, transactions, commissions, clicks, or programme-list
 * endpoint. Affiliate performance data still lives in the Associates Central
 * dashboard and its CSV/scheduled report exports, not in this API. That shapes
 * which of the seven canonical operations we can implement:
 *
 *   listProgrammes      — Amazon is a single programme per (marketplace, partner
 *                         tag). There is no catalogue of "merchants you could
 *                         join". We synthesise exactly one Programme per
 *                         configured partner tag (see `partnerTagProgramme`).
 *   getProgramme        — returns that same synthesised programme.
 *   listTransactions    — NotImplementedError: no reporting endpoint.
 *   getEarningsSummary  — NotImplementedError: derived from listTransactions,
 *                         which is unavailable.
 *   listClicks          — NotImplementedError: no click data via the API.
 *   generateTrackingLink— deterministic Amazon affiliate URL (`?tag=<partnerTag>`).
 *   verifyAuth          — OAuth2 client-credentials token exchange (cheap; no
 *                         ASIN needed). Delegated to auth.ts.
 *
 * Two admin ops (`listPublishers`, `listPublisherSectors`) are scaffolded for
 * v0.2 and throw `NotImplementedError` at v0.1.
 *
 * Cardinal rules (see Awin's adapter header for the full reasoning): never call
 * `fetch` outside client.ts; every failure round-trips through a
 * `NetworkErrorEnvelope`; preserve raw payloads in `rawNetworkData`; normalise
 * status enums; compute `ageDays`; UK English ("programme", not "program").
 *
 * HONESTY: this adapter has NOT been validated against a live Creators API
 * account. The catalog host/paths/scope and the tracking-link parameter shape
 * are reconstructed from public client libraries and migration write-ups
 * (recorded in docs/networks/amazon-creators.md); the exact API shape needs
 * live verification. claim_status is `experimental` accordingly.
 */

import {
  AMAZON_CREATORS_SLUG,
  AMAZON_CREATORS_BASE_URL,
  DEFAULT_MARKETPLACE,
} from './client.js';
import {
  verifyAuth as authVerify,
  validateCredential as authValidate,
  readCredentials,
} from './auth.js';
import { setupSteps } from './setup.js';
import { getCredential, requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { registerAdapter } from '../../shared/registry.js';
import { createLogger } from '../../shared/logging.js';
import {
  NotImplementedError,
  type Click,
  type ClickQuery,
  type CredentialValidationResult,
  type EarningsSummary,
  type NetworkAdapter,
  type NetworkCapabilities,
  type NetworkMeta,
  type OperationCapability,
  type Programme,
  type ProgrammeQuery,
  type ResilienceConfigMap,
  type SetupStep,
  type TrackingLink,
  type Transaction,
  type TransactionQuery,
} from '../../shared/types.js';

const log = createLogger('amazon-creators.adapter');

const SLUG = AMAZON_CREATORS_SLUG;
const NAME = 'Amazon Creators';

const NO_REPORTING_API =
  'The Amazon Creators API is a product-catalog API only (getItems / searchItems); ' +
  'it exposes no earnings, transactions, commissions or clicks endpoint. ' +
  'Affiliate performance data is available only in the Associates Central dashboard and its CSV report exports.';

const META: NetworkMeta = {
  slug: SLUG,
  name: NAME,
  baseUrl: AMAZON_CREATORS_BASE_URL,
  // OAuth2 client-credentials replaces the old PA-API AWS SigV4. We classify
  // this as `custom` rather than `oauth2` because the token region group and
  // the `x-marketplace` header are Amazon-specific wiring beyond a plain
  // bearer/oauth2 flow, and because the shape is unverified against a live tenant.
  authModel: 'custom',
  docsUrl: 'https://affiliate-program.amazon.com/creatorsapi/docs',
  adapterVersion: '0.1.0',
  lastVerified: '2026-06-05',
  claimStatus: 'experimental',
  knownLimitations: [
    'Experimental: this adapter has not been validated against a live Amazon Creators API account; the exact API shape needs live verification.',
    NO_REPORTING_API,
    'listTransactions, getEarningsSummary and listClicks are unsupported because the Creators API has no reporting surface.',
    'Programmes are synthesised: Amazon is a single programme per (marketplace, partner tag), so listProgrammes/getProgramme return one synthetic programme rather than a queryable catalogue.',
    'Amount unit is assumed to be the marketplace major currency unit (e.g. USD/GBP), not minor units; this is unverified and moot at v0.1 because no monetary data is returned by the supported operations.',
    'Successor to the Product Advertising API (PA-API 5.0), which deprecates 30 April 2026 and retires 15 May 2026; the auth model (OAuth2 client-credentials, scope creatorsapi::default) and catalog host (creatorsapi.amazon) are reconstructed from public sources and need confirmation against a live account.',
  ],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: true,
  setupApprovalDaysTypical: 1,
  side: 'publisher',
  credentialScope: 'single-brand',
};

const RESILIENCE: ResilienceConfigMap = {
  default: DEFAULT_RESILIENCE,
};

// ---------------------------------------------------------------------------
// Synthetic programme
// ---------------------------------------------------------------------------

/**
 * Amazon's affiliate relationship is one programme per marketplace per partner
 * tag. The Creators API has no "list programmes" endpoint and no concept of
 * joining/leaving individual merchant programmes, so we synthesise exactly one
 * Programme from the configured credentials.
 *
 * The programme id is the partner tag — stable, user-recognisable, and the
 * value the catalog API and tracking links key on. `status` is always `joined`:
 * if the user has a working partner tag they are, by definition, in the Amazon
 * Associates programme. We do not invent a commission rate (Amazon's rates are
 * category-dependent and not exposed by this API), so `commissionRate` is left
 * undefined rather than guessed.
 */
function partnerTagProgramme(partnerTag: string, marketplace: string): Programme {
  return {
    id: partnerTag,
    name: `Amazon Associates (${marketplace})`,
    network: SLUG,
    status: 'joined',
    advertiserUrl: `https://${marketplace}/`,
    rawNetworkData: {
      synthesised: true,
      reason:
        'The Amazon Creators API has no programme-list endpoint; Amazon is a single programme per (marketplace, partner tag).',
      partnerTag,
      marketplace,
    },
  };
}

export class AmazonCreatorsAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = NAME;
  readonly meta = META;
  readonly resilienceConfig = RESILIENCE;

  // -------------------------------------------------------------------------
  // listProgrammes
  // -------------------------------------------------------------------------

  /**
   * Return the single synthetic Amazon Associates programme for the configured
   * partner tag. There is no upstream call: the Creators API does not enumerate
   * programmes (see file header). We still require the partner tag to be
   * configured so a half-set-up environment fails with an actionable hint.
   *
   * The client-side filters mirror Awin's so the contract is uniform: a
   * `search` that does not match the programme name, a `status` filter that
   * excludes `joined`, or a non-empty `categories` filter all yield an empty
   * list rather than a fabricated match.
   */
  async listProgrammes(query?: ProgrammeQuery): Promise<Programme[]> {
    const partnerTag = requireCredential('AMAZON_PARTNER_TAG', {
      network: SLUG,
      operation: 'listProgrammes',
      hint: 'Set AMAZON_PARTNER_TAG (your Associates tracking ID, e.g. "yoursite-20").',
    });
    const marketplace = getCredential('AMAZON_MARKETPLACE') ?? DEFAULT_MARKETPLACE;

    let programmes = [partnerTagProgramme(partnerTag, marketplace)];

    if (query?.search) {
      const needle = query.search.toLowerCase();
      programmes = programmes.filter(
        (p) => p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle),
      );
    }
    if (query?.status) {
      const wanted = new Set(Array.isArray(query.status) ? query.status : [query.status]);
      programmes = programmes.filter((p) => wanted.has(p.status));
    }
    if (query?.categories && query.categories.length > 0) {
      // The synthetic programme carries no categories; a categories filter
      // therefore excludes it rather than inventing a match.
      programmes = [];
    }
    if (typeof query?.limit === 'number') {
      programmes = programmes.slice(0, query.limit);
    }

    return programmes;
  }

  // -------------------------------------------------------------------------
  // getProgramme
  // -------------------------------------------------------------------------

  /**
   * Return the synthetic programme. The only valid id is the configured partner
   * tag; any other id is surfaced as a config_error with a hint pointing at
   * listProgrammes, rather than fabricating a programme for an arbitrary id.
   */
  async getProgramme(programmeId: string): Promise<Programme> {
    const partnerTag = requireCredential('AMAZON_PARTNER_TAG', {
      network: SLUG,
      operation: 'getProgramme',
      hint: 'Set AMAZON_PARTNER_TAG (your Associates tracking ID, e.g. "yoursite-20").',
    });
    const marketplace = getCredential('AMAZON_MARKETPLACE') ?? DEFAULT_MARKETPLACE;

    if (programmeId && programmeId !== partnerTag) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'getProgramme',
          message: `Amazon has a single programme per partner tag; the only valid id is your configured partner tag "${partnerTag}", received "${programmeId}".`,
          hint: 'Call affiliate_amazon_creators_list_programmes to see the synthesised programme id.',
        }),
      );
    }

    return partnerTagProgramme(partnerTag, marketplace);
  }

  // -------------------------------------------------------------------------
  // listTransactions
  // -------------------------------------------------------------------------

  /**
   * Unsupported. The Creators API has no reporting endpoint; earnings and
   * orders live only in the Associates Central dashboard and CSV exports. We
   * throw NotImplementedError rather than returning an empty array so the
   * difference between "no transactions" and "no API" is honest (principle 4.1).
   */
  async listTransactions(_query?: TransactionQuery): Promise<Transaction[]> {
    throw new NotImplementedError(NO_REPORTING_API);
  }

  // -------------------------------------------------------------------------
  // getEarningsSummary
  // -------------------------------------------------------------------------

  /**
   * Unsupported for the same reason as listTransactions (the summary is derived
   * from transactions, which the API does not expose).
   */
  async getEarningsSummary(_query?: TransactionQuery): Promise<EarningsSummary> {
    throw new NotImplementedError(NO_REPORTING_API);
  }

  // -------------------------------------------------------------------------
  // listClicks
  // -------------------------------------------------------------------------

  /** Unsupported: the Creators API exposes no click-level data. */
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(
      'The Amazon Creators API does not expose click-level data.',
    );
  }

  // -------------------------------------------------------------------------
  // generateTrackingLink
  // -------------------------------------------------------------------------

  /**
   * Construct a deterministic Amazon affiliate URL by appending the partner tag
   * as the `tag` query parameter to the destination URL.
   *
   * Amazon's affiliate attribution is the documented, stable `?tag=<partnerTag>`
   * convention on any product/storefront URL on the associate's marketplace —
   * no API round-trip is required (and the Creators API has no link-generation
   * endpoint anyway). We preserve any existing query string and overwrite an
   * existing `tag` so the result is unambiguous.
   *
   * `input.programmeId` is optional here: the canonical programme is the
   * partner tag, so we default to the configured AMAZON_PARTNER_TAG. If the
   * caller passes a programmeId that is not the partner tag we reject it rather
   * than silently tagging with the wrong id.
   */
  async generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    const partnerTag = requireCredential('AMAZON_PARTNER_TAG', {
      network: SLUG,
      operation: 'generateTrackingLink',
      hint: 'Set AMAZON_PARTNER_TAG (your Associates tracking ID, e.g. "yoursite-20").',
    });

    if (!input.destinationUrl) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: 'destinationUrl is required.',
          hint: 'Pass the full Amazon product or storefront URL you want to tag.',
        }),
      );
    }

    if (input.programmeId && input.programmeId !== partnerTag) {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `programmeId must be your partner tag "${partnerTag}" (or omitted); received "${input.programmeId}".`,
          hint: 'Amazon tracking links carry your single partner tag. Omit programmeId to use the configured tag.',
        }),
      );
    }

    let url: URL;
    try {
      url = new URL(input.destinationUrl);
    } catch {
      throw new NetworkError(
        buildErrorEnvelope({
          type: 'config_error',
          network: SLUG,
          operation: 'generateTrackingLink',
          message: `destinationUrl is not a valid absolute URL: "${input.destinationUrl}".`,
          hint: 'Pass a full URL including the scheme, e.g. https://www.amazon.com/dp/B08N5WRWNW.',
        }),
      );
    }

    url.searchParams.set('tag', partnerTag);
    const trackingUrl = url.toString();

    return {
      network: SLUG,
      destinationUrl: input.destinationUrl,
      trackingUrl,
      programmeId: partnerTag,
      createdAt: new Date().toISOString(),
      rawNetworkData: {
        format: 'Amazon affiliate ?tag= deterministic construction',
        tag: partnerTag,
        destinationUrl: input.destinationUrl,
      },
    };
  }

  // -------------------------------------------------------------------------
  // verifyAuth
  // -------------------------------------------------------------------------

  /**
   * Delegate to auth.verifyAuth, which performs the OAuth2 client-credentials
   * token exchange (the cheapest credential-revealing call; no ASIN required).
   */
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    const result = await authVerify();
    if (result.ok) {
      return result.identity ? { ok: true, identity: result.identity } : { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  // -------------------------------------------------------------------------
  // Admin operations (v0.2 scaffolds)
  // -------------------------------------------------------------------------

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('Brand-side operations are scaffolded for v0.2');
  }

  // -------------------------------------------------------------------------
  // validateCredential / setupSteps
  // -------------------------------------------------------------------------

  async validateCredential(field: string, value: string): Promise<CredentialValidationResult> {
    return authValidate(field, value);
  }

  setupSteps(): SetupStep[] {
    return setupSteps();
  }

  // -------------------------------------------------------------------------
  // capabilitiesCheck
  // -------------------------------------------------------------------------

  /**
   * Probe each operation. The supported ops (listProgrammes, getProgramme,
   * generateTrackingLink) are deterministic and cheap; verifyAuth performs the
   * token exchange. The three reporting ops and listClicks are recorded as
   * unsupported without probing — calling them is pure waste.
   */
  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    const operations: Record<string, OperationCapability> = {};

    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const start = Date.now();
      try {
        const result = await fn();
        operations[name] = {
          supported: true,
          latencyMs: Date.now() - start,
          sampleSize: Array.isArray(result) ? result.length : 1,
        };
      } catch (err) {
        operations[name] = {
          supported: false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    };

    await probe('listProgrammes', () => this.listProgrammes({ limit: 1 }));
    await probe('verifyAuth', () => this.verifyAuth());

    operations['getProgramme'] = {
      supported: true,
      note: 'Returns the single synthetic programme for the configured partner tag; not probed automatically.',
    };
    operations['generateTrackingLink'] = {
      supported: true,
      note: 'Deterministic ?tag= URL construction; no live probe.',
    };
    operations['listTransactions'] = { supported: false, note: NO_REPORTING_API };
    operations['getEarningsSummary'] = { supported: false, note: NO_REPORTING_API };
    operations['listClicks'] = {
      supported: false,
      note: 'The Amazon Creators API does not expose click-level data.',
    };

    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations,
      knownLimitations: META.knownLimitations,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level registration (see Awin adapter for the aggregator rationale).
// ---------------------------------------------------------------------------

export const amazonCreatorsAdapter = new AmazonCreatorsAdapter();
registerAdapter(amazonCreatorsAdapter);

// Internal test helpers — exported under `_` so they don't appear in the
// public adapter surface.
export const _internals = {
  partnerTagProgramme,
  readCredentials,
  NO_REPORTING_API,
};

// Silence the unused-import lint for the logger when noUnusedLocals is on.
void log;
