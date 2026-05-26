/**
 * Impact advertiser HTTP client.
 *
 * Read-only by design: the client refuses any non-GET method at runtime so
 * the adapter cannot accidentally ship a write operation. This is belt-and-
 * braces alongside the read-only credential we recommend in the network
 * setup notes. The defence-in-depth matters because the Impact advertiser
 * surface DOES expose mutation endpoints (commission changes, action
 * approvals) and we want zero risk of one accidentally going out.
 *
 * Path construction:
 *
 *   - agency tier:        /Agencies/{AgencySID}/Advertisers/{BrandSID}/...
 *   - brand-direct tier:  /Advertisers/{BrandSID}/...
 *
 * Adapter code calls `impactAdvRequest({ ..., operation, brandPath: '/Campaigns' })`
 * with a brand-relative path. The client prepends the right tier prefix based
 * on the detected credential shape. There's also `agencyPath` for the
 * `/Agencies/{SID}/Advertisers` discovery endpoint that lives one level up.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { basicAuthHeader, getDetectedCredentials, SLUG } from './auth.js';

const log = createLogger('impact-advertiser.client');

export const IMPACT_ADV_BASE_URL = 'https://api.impact.com';

export interface ImpactAdvRequestInput {
  operation: AnyOperation;
  /**
   * Brand-relative path under the detected tier prefix. Example: `/Campaigns`
   * resolves to `/Advertisers/{BrandSID}/Campaigns` under brand-direct creds
   * and `/Agencies/{AgencySID}/Advertisers/{BrandSID}/Campaigns` under agency
   * creds.
   *
   * Either `brandPath` (with `networkBrandId`) or `agencyPath` (the discovery
   * endpoint) must be provided. Not both.
   */
  brandPath?: string;
  /**
   * Path under `/Agencies/{AgencySID}`, used for `listBrands` discovery only.
   * Ignored when shape is `brand-direct`.
   */
  agencyPath?: string;
  /**
   * The brand id whose data we want — `ctx.networkBrandId` from the resolver.
   * Required when `brandPath` is used.
   */
  networkBrandId?: string;
  /** Method. Always `GET` at v0.1; passing anything else throws. */
  method?: 'GET';
  query?: Record<string, string | number | undefined>;
  resilience: ResilienceConfig;
}

/**
 * Issue a single Impact advertiser API request under the resilience policy.
 *
 * Cardinal: only GET is permitted. Any other method throws a `config_error`
 * before the network call goes out.
 */
export async function impactAdvRequest<T>(input: ImpactAdvRequestInput): Promise<T> {
  // Hard read-only guard. This adapter ships read-only at v0.1 and a future
  // contributor must consciously remove this throw to enable writes.
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Impact advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift this ' +
          'guard explicitly AND the operator must rotate to a read-write Impact token.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const creds = await getDetectedCredentials(input.operation);
      const url = buildUrl(
        creds.shape,
        creds.accountSid,
        input.brandPath,
        input.agencyPath,
        input.networkBrandId,
        input.query,
      );

      const init: RequestInit = {
        method: 'GET',
        headers: {
          Authorization: basicAuthHeader(creds.accountSid, creds.authToken),
          Accept: 'application/json',
        },
      };

      log.debug({ url, operation: input.operation, shape: creds.shape }, 'impact-adv request');

      const res = await fetch(url, init);
      const rawBody = await res.text();
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Impact advertiser ${input.operation} GET ${url} → HTTP ${res.status}`,
        );
      }
      const trimmed = rawBody.trim();
      if (trimmed === '' || trimmed === 'null') return {} as T;
      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Impact advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the absolute URL for a brand-relative or agency-relative path.
 *
 * Exported (and re-exported on `_internals` in the adapter) so tests can
 * assert URL shape directly — the agency-passthrough vs brand-direct
 * pathing is the single most error-prone piece of this adapter.
 */
export function buildUrl(
  shape: 'agency' | 'brand-direct',
  accountSid: string,
  brandPath: string | undefined,
  agencyPath: string | undefined,
  networkBrandId: string | undefined,
  query?: Record<string, string | number | undefined>,
): string {
  if (brandPath && agencyPath) {
    throw new Error(
      'impactAdvRequest: pass exactly one of brandPath or agencyPath, not both.',
    );
  }
  if (!brandPath && !agencyPath) {
    throw new Error('impactAdvRequest: one of brandPath / agencyPath is required.');
  }

  let fullPath: string;
  if (agencyPath) {
    if (shape !== 'agency') {
      throw new Error(
        'impactAdvRequest: agencyPath is only valid under agency-tier credentials.',
      );
    }
    const rel = agencyPath.startsWith('/') ? agencyPath : `/${agencyPath}`;
    fullPath = `/Agencies/${encodeURIComponent(accountSid)}${rel}`;
  } else {
    const bp = brandPath as string;
    const rel = bp.startsWith('/') ? bp : `/${bp}`;
    if (!networkBrandId) {
      throw new Error('impactAdvRequest: networkBrandId is required with brandPath.');
    }
    const brandSeg = `/Advertisers/${encodeURIComponent(networkBrandId)}`;
    if (shape === 'agency') {
      fullPath = `/Agencies/${encodeURIComponent(accountSid)}${brandSeg}${rel}`;
    } else {
      fullPath = `${brandSeg}${rel}`;
    }
  }

  const url = new URL(fullPath, IMPACT_ADV_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
