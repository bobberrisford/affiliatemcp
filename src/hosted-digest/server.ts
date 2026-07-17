/**
 * HTTP surface of the digest-compose service (workstream slice H6,
 * redesigned per Rob's 2026-07-14 decision — see `hosted/README.md`,
 * "Digest orchestration and token scopes"). A plain `node:http` listener
 * with exactly two routes:
 *
 *   GET  /health   → unauthenticated liveness, matching every other service
 *                    in this repo.
 *   POST /compose  → { userId, digestType } with the hosted Worker's
 *                    freshly-minted, digest-scoped, per-user session token
 *                    as `Authorization: Bearer …`, plus (when configured)
 *                    the doorbell in `x-compose-auth`. Returns the rendered
 *                    `{ subject, body }` plain text. Never an email address,
 *                    in either direction.
 *
 * Authorisation model, stated plainly: this service performs NO token
 * verification of its own — it cannot (verification requires the signing
 * key, which lives only in the hosted Worker) and it does not need to. The
 * token is simply forwarded to the vault list/reveal routes, which run the
 * same session guard as always and serve only that token's own userId. A
 * caller with no token, an expired token, or a tampered token gets vault
 * 401s and therefore no data. The optional doorbell secret only decides
 * whether the endpoint answers at all; it authorises nothing (see
 * `env.ts`'s `composeSecret` doc comment).
 *
 * One stderr audit line per compose request: userId, digestType, timestamp,
 * outcome. NEVER the composed subject or body.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { createLogger } from '../shared/logging.js';
import { VaultUnavailableError } from '../hosted-transport/vault-client.js';
import type { HostedDigestConfig } from './env.js';
import type { DigestType } from './compose.js';
import { composeDigestForUser } from './run.js';

const log = createLogger('hosted-digest');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isDigestType(value: unknown): value is DigestType {
  return value === 'earnings' || value === 'unpaid-commissions';
}

/** Constant-time doorbell comparison — a bearer-style check, so an early-exit `===` would leak
 * matched-prefix length to a network-timing attacker, cheap to avoid with `node:crypto`. */
function doorbellMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One audit line per compose request. NEVER the composed subject or body. */
function recordComposeAudit(userId: string, digestType: string, outcome: 'composed' | 'vault_unavailable' | 'error'): void {
  log.info({ userId, digestType, timestamp: new Date().toISOString(), outcome }, 'digest compose request');
}

export interface HostedDigestServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** Start the compose service on `config.port` (`0` picks an ephemeral port — what tests use). */
export async function startHostedDigestServer(config: HostedDigestConfig): Promise<HostedDigestServerHandle> {
  async function handleCompose(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (config.composeSecret) {
      const presentedHeader = req.headers['x-compose-auth'];
      const presented = Array.isArray(presentedHeader) ? presentedHeader[0] : presentedHeader;
      if (!doorbellMatches(presented, config.composeSecret)) {
        sendJson(res, 401, { error: 'compose_auth_required' });
        return;
      }
    }

    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { error: 'missing_token' });
      return;
    }

    let body: { userId?: unknown; digestType?: unknown };
    try {
      const raw = await readRequestBody(req);
      body = raw.length > 0 ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    if (typeof body.userId !== 'string' || body.userId.length === 0) {
      sendJson(res, 400, { error: 'invalid_user_id' });
      return;
    }
    if (!isDigestType(body.digestType)) {
      sendJson(res, 400, { error: 'invalid_digest_type' });
      return;
    }

    try {
      const digest = await composeDigestForUser(config.vaultUrl, body.userId, body.digestType, token);
      recordComposeAudit(body.userId, body.digestType, 'composed');
      sendJson(res, 200, digest);
    } catch (err) {
      if (err instanceof VaultUnavailableError) {
        // Includes the vault rejecting the token (expired digest token,
        // tampered token): the caller gets an honest 502-class failure, not
        // an empty digest that looks like "no earnings this week".
        recordComposeAudit(body.userId, body.digestType, 'vault_unavailable');
        sendJson(res, 502, { error: 'vault_unavailable', message: err.message });
        return;
      }
      log.error({ message: (err as Error).message }, 'compose failed unexpectedly');
      recordComposeAudit(body.userId, body.digestType, 'error');
      sendJson(res, 500, { error: 'compose_failed' });
    }
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/compose' && req.method === 'POST') {
      handleCompose(req, res).catch((err) => {
        log.error({ message: (err as Error).message }, 'unhandled compose request error');
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  log.info({ port }, 'digest-compose service listening');

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
