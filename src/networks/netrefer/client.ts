/**
 * NetRefer ASR HTTP client — the only sanctioned network I/O path.
 *
 * Same hard rules as the Awin / Rakuten clients:
 *   1. No `fetch` outside this file inside the netrefer/ folder.
 *   2. Every request flows through `withResilience` so timeouts, retries, and
 *      the circuit breaker apply uniformly.
 *   3. Non-2xx responses throw `HttpStatusError` so the resilience layer can
 *      classify and retry by status policy alone.
 *   4. Raw response bodies are preserved verbatim on failure (principle 4.1).
 *
 * NetRefer-specific differences:
 *
 *   - **Per-operator base URL**: the ASR data host is NOT fixed. NetRefer
 *     issues each operator/affiliate a host at onboarding, supplied as the
 *     `NETREFER_BASE_URL` credential. We read and validate it on every call
 *     rather than hard-coding a constant. This is the central deviation from
 *     Rakuten, whose base URL is a module constant.
 *
 *   - **Bearer token from cache**: every call asks `auth.getAccessToken()` for
 *     a JWT rather than receiving one from the caller. The cache lives in
 *     `auth.ts` and refreshes proactively when the lifetime gets short.
 *
 *   - **401 → refresh → retry once**: if the data endpoint returns 401 with a
 *     cached token, the cache may be stale. We force-refresh and retry the
 *     original call exactly once (logged at debug — not hidden).
 */

import { getAccessToken, refreshToken } from './auth.js';
import { requireCredential } from '../../shared/config.js';
import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('netrefer.client');

const SLUG = 'netrefer';

/**
 * Read and validate the per-operator ASR base URL from the credential.
 *
 * Unlike Rakuten (fixed host), NetRefer's data host varies per operator. A
 * malformed value surfaces as a `config_error` envelope here rather than as an
 * opaque fetch failure deeper down.
 */
export function resolveBaseUrl(operation: string): string {
  const raw = requireCredential('NETREFER_BASE_URL', {
    network: SLUG,
    operation,
    hint: 'Set NETREFER_BASE_URL to the per-operator ASR host NetRefer issued at onboarding (e.g. https://asr.operator.netrefer.com).',
  });
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`unsupported protocol "${url.protocol}"`);
    }
    // Normalise: strip a trailing slash so path-joining is predictable.
    return url.toString().replace(/\/$/, '');
  } catch (err) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `NETREFER_BASE_URL is not a valid URL: "${raw}" (${(err as Error).message}).`,
        hint: 'Provide the full ASR base URL including the scheme, e.g. https://asr.example.netrefer.com.',
      }),
    );
  }
}

export interface NetreferRequestInput {
  /** Canonical operation name — used as the breaker key and in error envelopes. */
  operation: AnyOperation;
  /** Path beginning with `/` — joined to the per-operator base URL. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. `undefined` values are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single NetRefer ASR request under the resilience policy with the
 * 401-refresh-retry-once behaviour. See the Rakuten client for the rationale
 * behind collapsing the refresh-retry into a single resilience callable.
 */
export async function netreferRequest<T>(input: NetreferRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const baseUrl = resolveBaseUrl(input.operation);

  return withResilience(
    ctx,
    async () => doRequestWith401Refresh<T>(input, baseUrl),
    input.resilience,
  );
}

async function doRequestWith401Refresh<T>(
  input: NetreferRequestInput,
  baseUrl: string,
): Promise<T> {
  let token = await getAccessToken();

  const firstAttempt = await rawRequest<T>(input, baseUrl, token);
  if (firstAttempt.kind === 'ok') return firstAttempt.value;

  if (firstAttempt.status === 401) {
    log.debug(
      {
        operation: input.operation,
        path: input.path,
        reason: 'NetRefer returned 401 with cached token; forcing refresh and retrying once',
      },
      'netrefer 401 → refreshing token',
    );
    token = await refreshToken({ reason: '401 from data endpoint' });
    const secondAttempt = await rawRequest<T>(input, baseUrl, token);
    if (secondAttempt.kind === 'ok') return secondAttempt.value;
    throw new HttpStatusError(
      secondAttempt.status,
      secondAttempt.body,
      `NetRefer ${input.operation} ${input.method ?? 'GET'} ${input.path} → HTTP ${secondAttempt.status} after token refresh`,
    );
  }

  throw new HttpStatusError(
    firstAttempt.status,
    firstAttempt.body,
    `NetRefer ${input.operation} ${input.method ?? 'GET'} ${input.path} → HTTP ${firstAttempt.status}`,
  );
}

type RawResult<T> = { kind: 'ok'; value: T } | { kind: 'err'; status: number; body: string };

async function rawRequest<T>(
  input: NetreferRequestInput,
  baseUrl: string,
  token: string,
): Promise<RawResult<T>> {
  const url = buildUrl(baseUrl, input.path, input.query);
  const init: RequestInit = {
    method: input.method ?? 'GET',
    headers: buildHeaders(token, input.body !== undefined),
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }
  if (input.signal) {
    init.signal = input.signal;
  }

  log.debug({ url, method: init.method, operation: input.operation }, 'netrefer request');

  const res = await fetch(url, init);
  const rawBody = await res.text();

  if (!res.ok) {
    return { kind: 'err', status: res.status, body: rawBody };
  }

  if (rawBody.trim() === '') {
    return { kind: 'ok', value: {} as T };
  }

  try {
    return { kind: 'ok', value: JSON.parse(rawBody) as T };
  } catch (err) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'network_api_error',
        network: SLUG,
        operation: input.operation,
        httpStatus: res.status,
        networkErrorBody: rawBody,
        message: `NetRefer ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
      }),
    );
  }
}

function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(
  baseUrl: string,
  pathname: string,
  query: Record<string, string | number | undefined> | undefined,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, `${baseUrl}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
