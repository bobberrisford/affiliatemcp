/**
 * Tests for the desktop entitlement client (src/core/entitlement.ts).
 *
 * Sandboxes the config dir via AFFILIATE_MCP_CONFIG_DIR and signs test tokens
 * with the DEV private key whose PUBLIC half is embedded in the module, so the
 * verify path is exercised against the real embedded key. Also pins the
 * free-tier invariant: with no account key, nothing calls the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ENTITLEMENT_PUBLIC_KEY_SPKI_B64,
  entitlementStatus,
  refreshEntitlement,
  signOutEntitlement,
  verifyEntitlementToken,
} from '../../src/core/entitlement.js';

// The DEV private key matching the module's embedded DEV public key.
const DEV_PRIV_PKCS8_B64 = 'MC4CAQAwBQYDK2VwBCIEIFZT6ODyaYZmnDsjl/m2qO3kAJ+wamVO+9ftpqTvQbXa';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function signToken(exp: number, akey = 'amcp_acc_test'): Promise<string> {
  const payload = { akey, product: 'desktop-premium', iss: 1, exp, v: 1 };
  const key = await crypto.subtle.importKey(
    'pkcs8',
    b64ToBytes(DEV_PRIV_PKCS8_B64).buffer as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payloadBytes);
  return `amcpe_${b64url(payloadBytes)}.${b64url(new Uint8Array(sig))}`;
}

let dir: string;
const prevConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'amcp-ent-'));
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = dir;
});
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeStore(obj: unknown): void {
  writeFileSync(path.join(dir, 'entitlement.json'), JSON.stringify(obj), 'utf8');
}

describe('verifyEntitlementToken', () => {
  it('verifies a token signed by the matching DEV key against the embedded public key', async () => {
    const token = await signToken(2_000_000_000);
    const payload = await verifyEntitlementToken(token, ENTITLEMENT_PUBLIC_KEY_SPKI_B64);
    expect(payload).not.toBeNull();
    expect(payload!.akey).toBe('amcp_acc_test');
  });

  it('rejects a non-entitlement token', async () => {
    expect(await verifyEntitlementToken('amcp_not_entitlement.x')).toBeNull();
  });
});

describe('entitlementStatus', () => {
  it('is "none" and makes NO network call when there is no account key (free tier)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const status = await entitlementStatus();
    expect(status).toEqual({ entitled: false, state: 'none', hasAccount: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is "active" for a valid, unexpired cached token', async () => {
    const exp = 2_000_000_000;
    writeStore({ accountKey: 'amcp_acc_test', token: await signToken(exp), exp });
    const status = await entitlementStatus(exp - 100);
    expect(status.entitled).toBe(true);
    expect(status.state).toBe('active');
  });

  it('is "expired" once the cached token has lapsed', async () => {
    const exp = 1_000_000_000;
    writeStore({ accountKey: 'amcp_acc_test', token: await signToken(exp), exp });
    const status = await entitlementStatus(exp + 100);
    expect(status.entitled).toBe(false);
    expect(status.state).toBe('expired');
  });

  it('is "inactive" with an account key but no token', async () => {
    writeStore({ accountKey: 'amcp_acc_test' });
    const status = await entitlementStatus();
    expect(status.state).toBe('inactive');
    expect(status.hasAccount).toBe(true);
  });
});

describe('refreshEntitlement', () => {
  it('makes NO network call for the free tier (no account key)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const status = await refreshEntitlement();
    expect(status.state).toBe('none');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('signOutEntitlement', () => {
  it('clears the local store back to "none"', async () => {
    writeStore({ accountKey: 'amcp_acc_test', token: await signToken(2_000_000_000) });
    signOutEntitlement();
    expect((await entitlementStatus()).state).toBe('none');
  });
});
