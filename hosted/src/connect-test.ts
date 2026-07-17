/**
 * H5 connect-time credential test: one cheap, read-only API call per network,
 * run with a plain `fetch` inside this Worker, replicating the exact auth
 * shape and endpoint each network's LOCAL adapter already uses for its own
 * `verifyAuth()` check (`src/networks/<slug>/auth.ts` in the root workspace).
 *
 * Why this file does not import or call the adapters directly: the adapters
 * are Node-only code (`src/shared/resilience.ts`, `pino`-based logging,
 * `node:fs` config) that cannot run inside a Cloudflare Worker — the same
 * reason H4's remote MCP transport is a Node service and not code added to
 * this Worker (see `hosted/README.md`, "H4: remote MCP transport lives in the
 * root workspace, not here"). Rather than invent a new probe, this module
 * replicates the SAME request each adapter's `verifyAuth()` already sends —
 * same endpoint, same auth header shape, same "what counts as success" rule —
 * documented per network below so the duplication is visible and traceable
 * back to its source of truth, not a guess.
 *
 * Every function here:
 *   - takes only the plaintext credential fields it needs, never the whole
 *     record, and never logs a credential value, on any path;
 *   - returns a result that carries the verbatim upstream HTTP status and a
 *     bounded, HTML-safe-to-render snippet of the upstream body on failure —
 *     the network's own error response, not the user's secret — never
 *     inventing an "ok" result when the call did not clearly succeed;
 *   - never retries. This is a one-shot connect-time check, not a resilience
 *     policy; `src/shared/resilience.ts`'s "no retry on 4xx" rule does not
 *     apply here because there is no retry at all.
 */

import type { ConnectNetworkSlug } from './networks.js';

const MAX_BODY_SNIPPET_LENGTH = 500;

export type ConnectionTestResult =
  | { ok: true; detail?: string }
  | { ok: false; status?: number; detail: string };

function snippet(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > MAX_BODY_SNIPPET_LENGTH
    ? `${trimmed.slice(0, MAX_BODY_SNIPPET_LENGTH)}…`
    : trimmed;
}

/**
 * Awin: `GET /accounts?type=publisher`, `Authorization: Bearer <token>`.
 * Identical to `verifyAuth()` in `src/networks/awin/auth.ts` — the smallest
 * authenticated call Awin exposes, and it returns a clean 401 on a bad token
 * rather than a generic 5xx.
 */
async function testAwin(credentials: Record<string, string>): Promise<ConnectionTestResult> {
  const token = credentials['AWIN_API_TOKEN'];
  if (!token) return { ok: false, detail: 'AWIN_API_TOKEN is missing.' };

  let res: Response;
  try {
    res = await fetch('https://api.awin.com/accounts?type=publisher', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (err) {
    return { ok: false, detail: `Could not reach Awin: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, status: res.status, detail: `Awin responded HTTP ${res.status}: ${snippet(body)}` };
}

/**
 * CJ: `POST https://commissions.api.cj.com/query`, `Authorization: Bearer
 * <token>`, the same minimal `{ me { ... } }` GraphQL query as `verifyAuth()`
 * in `src/networks/cj/auth.ts`. A 200 response with a non-empty `errors`
 * array is treated as a failure, matching `cjGraphQL`'s own convention in
 * `src/networks/cj/client.ts` (a GraphQL error is a failure even when the
 * HTTP status is 200).
 */
async function testCj(credentials: Record<string, string>): Promise<ConnectionTestResult> {
  const token = credentials['CJ_API_TOKEN'];
  if (!token) return { ok: false, detail: 'CJ_API_TOKEN is missing.' };

  let res: Response;
  try {
    res = await fetch('https://commissions.api.cj.com/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'query { me { id companyId name email company { id name } } }',
        variables: {},
      }),
    });
  } catch (err) {
    return { ok: false, detail: `Could not reach CJ: ${(err as Error).message}` };
  }
  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, detail: `CJ responded HTTP ${res.status}: ${snippet(raw)}` };
  }
  let parsed: { data?: { me?: unknown }; errors?: Array<{ message?: string }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { ok: false, status: res.status, detail: `CJ returned a non-JSON body: ${snippet(raw)}` };
  }
  if (parsed.errors && parsed.errors.length > 0) {
    const messages = parsed.errors.map((e) => e.message ?? 'unknown error').join('; ');
    return { ok: false, status: res.status, detail: `CJ returned GraphQL errors: ${snippet(messages)}` };
  }
  return { ok: true };
}

/**
 * Impact: `GET /Mediapartners/{SID}/Campaigns?PageSize=1`, HTTP Basic
 * `base64(accountSid:authToken)`. Identical to `verifyAuth()` in
 * `src/networks/impact/auth.ts` — the smallest authenticated call that
 * reliably returns 200 even on an account with zero joined campaigns.
 */
async function testImpact(credentials: Record<string, string>): Promise<ConnectionTestResult> {
  const sid = credentials['IMPACT_ACCOUNT_SID'];
  const authToken = credentials['IMPACT_AUTH_TOKEN'];
  if (!sid || !authToken) return { ok: false, detail: 'IMPACT_ACCOUNT_SID and IMPACT_AUTH_TOKEN are both required.' };

  const basic = btoa(`${sid}:${authToken}`);
  let res: Response;
  try {
    res = await fetch(
      `https://api.impact.com/Mediapartners/${encodeURIComponent(sid)}/Campaigns?PageSize=1`,
      { method: 'GET', headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } },
    );
  } catch (err) {
    return { ok: false, detail: `Could not reach Impact: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, status: res.status, detail: `Impact responded HTTP ${res.status}: ${snippet(body)}` };
}

/**
 * Rakuten: the OAuth2 client-credentials token exchange itself,
 * `POST https://api.linksynergy.com/token`, HTTP Basic
 * `base64(clientId:clientSecret)`, form body `scope=<SID>`. Identical to the
 * exchange in `exchangeForToken()` / `verifyAuth()` in
 * `src/networks/rakuten/auth.ts` — a successful token exchange is what the
 * local adapter itself treats as conclusive proof the credentials work,
 * without an extra data-plane call.
 *
 * Known gap: the local CLI setup doc (`docs/networks/rakuten.md`) documents a
 * `RAKUTEN_TOKEN_URL` override for tenants provisioned against
 * `api.rakutenmarketing.com` instead of the default `api.linksynergy.com`.
 * This connect flow does not yet expose that override — a tenant on the
 * alternate host will see this test fail with a 404 even though the
 * credentials themselves may be valid. This is recorded as a known
 * limitation (see `hosted/README.md`) rather than silently unsupported.
 */
async function testRakuten(credentials: Record<string, string>): Promise<ConnectionTestResult> {
  const clientId = credentials['RAKUTEN_CLIENT_ID'];
  const clientSecret = credentials['RAKUTEN_CLIENT_SECRET'];
  const sid = credentials['RAKUTEN_SID'];
  if (!clientId || !clientSecret || !sid) {
    return { ok: false, detail: 'RAKUTEN_CLIENT_ID, RAKUTEN_CLIENT_SECRET, and RAKUTEN_SID are all required.' };
  }

  const basic = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({ scope: sid }).toString();
  let res: Response;
  try {
    res = await fetch('https://api.linksynergy.com/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (err) {
    return { ok: false, detail: `Could not reach Rakuten: ${(err as Error).message}` };
  }
  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, detail: `Rakuten token exchange responded HTTP ${res.status}: ${snippet(raw)}` };
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { ok: false, status: res.status, detail: `Rakuten returned a non-JSON body: ${snippet(raw)}` };
  }
  if (!parsed.access_token) {
    return {
      ok: false,
      status: res.status,
      detail: 'Rakuten returned HTTP 200 but no access_token field.',
    };
  }
  return { ok: true };
}

/**
 * Dispatch to the per-network test. Callers never invent success for an
 * unknown slug — that would hide a routing bug as a false positive.
 */
export async function testConnection(
  network: ConnectNetworkSlug,
  credentials: Record<string, string>,
): Promise<ConnectionTestResult> {
  switch (network) {
    case 'awin':
      return testAwin(credentials);
    case 'cj':
      return testCj(credentials);
    case 'impact':
      return testImpact(credentials);
    case 'rakuten':
      return testRakuten(credentials);
  }
}
