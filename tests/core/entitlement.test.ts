/**
 * Tests for the desktop entitlement client (src/core/entitlement.ts).
 *
 * Sandboxes the config dir via AFFILIATE_MCP_CONFIG_DIR. The module now embeds
 * the PRODUCTION public key, whose private half is only an issuer Worker
 * secret — so these tests sign tokens with an ephemeral Ed25519 pair generated
 * per run and pass its public half through the functions' injectable
 * `publicKeySpkiDerB64` parameter. The verify wire format is still exercised
 * end to end; only the trust anchor is substituted. Also pins the free-tier
 * invariant: with no account key, nothing calls the network.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  entitlementStatus,
  refreshEntitlement,
  signOutEntitlement,
  verifyEntitlementToken,
} from '../../src/core/entitlement.js';

// Ephemeral signing pair for this test run — see the file-header comment.
// (Key types derived from the subtle-crypto API: the tsconfig lib has no DOM
// CryptoKey/CryptoKeyPair globals.)
type TestCryptoKey = Parameters<typeof crypto.subtle.sign>[1];
let testPrivateKey: TestCryptoKey;
let testPublicKeyB64: string;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s);
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as { privateKey: TestCryptoKey; publicKey: TestCryptoKey };
  testPrivateKey = pair.privateKey;
  testPublicKeyB64 = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
});

async function signToken(exp: number, akey = 'amcp_acc_test'): Promise<string> {
  const payload = { akey, product: 'desktop-premium', iss: 1, exp, v: 1 };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, testPrivateKey, payloadBytes);
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
  it('verifies a token signed by the matching key', async () => {
    const token = await signToken(2_000_000_000);
    const payload = await verifyEntitlementToken(token, testPublicKeyB64);
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
    const status = await entitlementStatus(exp - 100, testPublicKeyB64);
    expect(status.entitled).toBe(true);
    expect(status.state).toBe('active');
  });

  it('is "expired" once the cached token has lapsed', async () => {
    const exp = 1_000_000_000;
    writeStore({ accountKey: 'amcp_acc_test', token: await signToken(exp), exp });
    const status = await entitlementStatus(exp + 100, testPublicKeyB64);
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
