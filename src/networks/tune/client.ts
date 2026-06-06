/**
 * TUNE (HasOffers) HTTP client — the ONLY path TUNE adapter methods use for
 * network I/O.
 *
 * TUNE is a CPA platform engine (formerly HasOffers): many independent networks
 * each run their own instance under their own subdomain. There is no single
 * shared API host. Each network's API base is `https://{network_id}.api.hasoffers.com`,
 * derived from the publisher's NetworkId. ONE adapter parameterised by that
 * NetworkId therefore covers every HasOffers-powered network.
 *
 * KEY DEVIATION from `src/networks/everflow/client.ts`: the base URL is NOT
 * hard-coded. It is built from the `TUNE_NETWORK_ID` credential and validated as
 * a URL here (mirroring `src/networks/affise/client.ts`). A missing/invalid
 * NetworkId surfaces as a `config_error` envelope — never a silent default to
 * some other tenant's host.
 *
 * Auth: TUNE's Affiliate API authenticates with two query parameters,
 * `api_key` (the affiliate API key from the publisher dashboard) and `NetworkId`.
 * It is not the HTTP `Authorization` convention, hence `auth_model: custom` in
 * `network.json`. The key is appended in the client so credential reads happen
 * once per operation in the adapter.
 *
 * Calls follow the Target/Method convention:
 *   GET https://{network_id}.api.hasoffers.com/Apiv3/json
 *       ?api_key={key}&NetworkId={id}&Target={Target}&Method={Method}&...
 *
 * Hard rules (mirrored from Awin/Everflow/Affise client.ts — read those for the
 * full rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential } from '../../shared/config.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tune.client');

const SLUG = 'tune';

/**
 * Build and validate the per-tenant TUNE base origin from the NetworkId credential.
 *
 * HasOffers has no canonical shared host: each network's API lives at its own
 * `{network_id}.api.hasoffers.com` subdomain. We read `TUNE_NETWORK_ID` and
 * construct the origin, validating the result with the WHATWG `URL` parser.
 *
 * We reject NetworkId values containing characters that are not valid in a DNS
 * label (anything outside `[A-Za-z0-9-]`) so a stray `/`, scheme, or whitespace
 * cannot smuggle the request onto a different host. Anything invalid becomes a
 * `config_error` envelope so the user gets an actionable message rather than a
 * confusing fetch failure later.
 *
 * Exported so `auth.ts` and tests can build the same host the client uses.
 */
export function resolveBaseUrl(operation: string): string {
  const raw = requireCredential('TUNE_NETWORK_ID', {
    network: SLUG,
    operation,
    hint:
      'Set TUNE_NETWORK_ID to your network identifier (the NetworkId shown alongside ' +
      'your API key in the publisher dashboard). The API host is built from it as ' +
      'https://{network_id}.api.hasoffers.com.',
  });

  const networkId = raw.trim();
  // NetworkId becomes the leftmost DNS label; constrain it to safe characters so
  // it cannot alter the host beyond that label.
  if (!/^[A-Za-z0-9-]+$/.test(networkId)) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `TUNE_NETWORK_ID must contain only letters, digits, and hyphens; received "${raw}".`,
        hint: 'Use the bare NetworkId from the publisher dashboard, e.g. "atollsnet".',
      }),
    );
  }

  const candidate = `https://${networkId}.api.hasoffers.com`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `TUNE_NETWORK_ID "${raw}" does not produce a valid API host.`,
        hint: 'Use the bare NetworkId from the publisher dashboard, e.g. "atollsnet".',
      }),
    );
  }

  return parsed.origin;
}

export interface TuneRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** The HasOffers API Target, e.g. `Affiliate_Offer`. */
  target: string;
  /** The HasOffers API Method on that target, e.g. `findAll`. */
  apiMethod: string;
  /** Affiliate API key. Passed in from auth helpers / the adapter. */
  apiKey: string;
  /** Per-tenant base origin, already built + validated via `resolveBaseUrl`. */
  baseUrl: string;
  /** The NetworkId, also sent as a query parameter (TUNE requires both). */
  networkId: string;
  /**
   * Query string parameters beyond Target/Method/api_key/NetworkId. Values with
   * `undefined` are skipped. Array values are emitted as repeated `key[]=v`
   * pairs; nested objects are flattened to `key[inner]=v` to match HasOffers'
   * bracketed filter convention (e.g. `filters[Stat.datetime][start]=...`).
   */
  query?: Record<string, TuneQueryValue | undefined>;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

export type TuneQueryValue =
  | string
  | number
  | Array<string | number>
  | { [key: string]: string | number | Array<string | number> };

/**
 * The HasOffers Apiv3 JSON envelope.
 *
 * Every response wraps the payload in a `response` object whose `status` is a
 * positive integer on success (and `<= 0` on failure), with the payload under
 * `response.data`. `data` carries `page` / `pageCount` / `count` for paginated
 * targets and a `data` array of model rows. We never trust the shape beyond this
 * — adapter transformers read fields defensively and preserve the raw row.
 */
export interface TuneEnvelope<T = unknown> {
  request?: Record<string, unknown>;
  response?: {
    status?: number;
    httpStatus?: number;
    errors?: unknown;
    errorMessage?: string;
    data?: T;
  };
}

/**
 * Issue a single TUNE Affiliate API request under the resilience policy.
 *
 * Returns the inner `response.data` payload (type `T`). When the HTTP call
 * succeeds (2xx) but the HasOffers envelope reports a failure (`status <= 0`),
 * we raise a `network_api_error` envelope carrying the verbatim body — HasOffers
 * returns HTTP 200 even for application-level errors, so a non-2xx check alone
 * would miss them (principle 4.1).
 */
export async function tuneRequest<T>(input: TuneRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input);
      const init: RequestInit = {
        method: 'GET',
        headers: { Accept: 'application/json' },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug(
        { url, target: input.target, method: input.apiMethod, operation: input.operation },
        'tune request',
      );

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). HasOffers error bodies
      // are JSON-shaped but may be plain text / HTML on CDN or gateway errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `TUNE ${input.operation} ${input.target}::${input.apiMethod} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `TUNE ${input.operation} returned an empty body.`,
          }),
        );
      }

      let parsed: TuneEnvelope<T>;
      try {
        parsed = JSON.parse(rawBody) as TuneEnvelope<T>;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `TUNE ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }

      const envelopeStatus = parsed.response?.status;
      // HasOffers signals application-level failure with status <= 0 over HTTP 200.
      if (typeof envelopeStatus === 'number' && envelopeStatus <= 0) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message:
              parsed.response?.errorMessage ??
              `TUNE ${input.operation} ${input.target}::${input.apiMethod} reported status ${envelopeStatus}.`,
          }),
        );
      }

      return (parsed.response?.data ?? ({} as T)) as T;
    },
    input.resilience,
  );
}

/**
 * Compose the full Apiv3 URL against the per-tenant base.
 *
 * We use `URL` + `URLSearchParams` so values are correctly encoded. The fixed
 * auth + routing params (`api_key`, `NetworkId`, `Target`, `Method`) are always
 * present; caller-supplied params are appended, with arrays emitted as repeated
 * `key[]=v` pairs and nested objects flattened to `key[inner]=v` to match
 * HasOffers' bracketed filter convention.
 */
function buildUrl(input: TuneRequestInput): string {
  const url = new URL('/Apiv3/json', input.baseUrl);
  const sp = url.searchParams;

  sp.set('api_key', input.apiKey);
  sp.set('NetworkId', input.networkId);
  sp.set('Target', input.target);
  sp.set('Method', input.apiMethod);

  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      if (v === undefined) continue;
      appendParam(sp, k, v);
    }
  }
  return url.toString();
}

function appendParam(sp: URLSearchParams, key: string, value: TuneQueryValue): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      sp.append(`${key}[]`, String(item));
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [inner, innerValue] of Object.entries(value)) {
      if (Array.isArray(innerValue)) {
        for (const item of innerValue) {
          sp.append(`${key}[${inner}][]`, String(item));
        }
      } else {
        sp.set(`${key}[${inner}]`, String(innerValue));
      }
    }
    return;
  }
  sp.set(key, String(value));
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
