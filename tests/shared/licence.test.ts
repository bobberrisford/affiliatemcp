import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign as cryptoSign,
} from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  base64urlDecode,
  base64urlEncode,
  readLicence,
  verifyLicenceToken,
} from '../../src/shared/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const DEV_KEY_PATH = path.join(repoRoot, 'licence-keys', 'dev-signing-key.pem');

const LICENCE_TOKEN_PREFIX = 'amcp_';

interface LicencePayload {
  lid: string;
  email: string;
  product: string;
  issued: string;
  v: number;
}

/** Sign a payload with the given Ed25519 private key into a v1 licence token. */
function signToken(payload: object, privateKey: KeyObject): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sigBytes = cryptoSign(null, payloadBytes, privateKey);
  return `${LICENCE_TOKEN_PREFIX}${base64urlEncode(payloadBytes)}.${base64urlEncode(sigBytes)}`;
}

function validPayload(overrides: Partial<LicencePayload> = {}): LicencePayload {
  return {
    lid: 'amcp_test123',
    email: 'buyer@acme.com',
    product: 'desktop',
    issued: '2026-06-07',
    v: 1,
    ...overrides,
  };
}

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 62, 63]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
  });

  it('produces url-safe output with no padding', () => {
    const enc = base64urlEncode(Buffer.from([0xff, 0xff, 0xff]));
    expect(enc).not.toMatch(/[+/=]/);
  });

  it('rejects strings with non-base64url characters', () => {
    expect(() => base64urlDecode('abc+def')).toThrow();
    expect(() => base64urlDecode('abc=')).toThrow();
  });
});

// ── Rejection cases run with an EPHEMERAL key (no dev key file needed). The
//    embedded public key won't match this pair, but every rejection path here
//    short-circuits before/independently of a successful signature, except the
//    "valid signature but wrong product/version" cases — which we sign with the
//    ephemeral key and assert are rejected for content reasons. To test those
//    against the REAL embedded key we use the dev key block below.
describe('verifyLicenceToken — rejections (ephemeral key, always runs)', () => {
  const { privateKey } = generateKeyPairSync('ed25519');

  it('rejects a missing prefix', () => {
    const t = signToken(validPayload(), privateKey).slice(LICENCE_TOKEN_PREFIX.length);
    const r = verifyLicenceToken(t);
    expect(r.valid).toBe(false);
  });

  it('rejects malformed structure (no dot)', () => {
    const r = verifyLicenceToken('amcp_notadottedstring');
    expect(r.valid).toBe(false);
  });

  it('rejects bad base64 in the payload', () => {
    const r = verifyLicenceToken('amcp_!!!.###');
    expect(r.valid).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(verifyLicenceToken('').valid).toBe(false);
    expect(verifyLicenceToken('hello world').valid).toBe(false);
    expect(verifyLicenceToken('amcp_').valid).toBe(false);
  });

  it('rejects a signature that does not match the embedded key', () => {
    // Signed with the ephemeral key, not the embedded dev key → signature fails.
    const r = verifyLicenceToken(signToken(validPayload(), privateKey));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/signature/i);
  });
});

// ── These cases need the dev PRIVATE key so the signature is genuinely valid
//    against the embedded public key. Skip gracefully if the gitignored key is
//    absent (e.g. a fresh checkout that hasn't run the generator).
const hasDevKey = existsSync(DEV_KEY_PATH);
const describeDevKey = hasDevKey ? describe : describe.skip;

describeDevKey('verifyLicenceToken — with the dev signing key', () => {
  let devKey: KeyObject;

  beforeEach(() => {
    devKey = createPrivateKey(readFileSync(DEV_KEY_PATH, 'utf8'));
  });

  it('accepts a real signed token and returns the payload fields', () => {
    const token = signToken(validPayload(), devKey);
    const r = verifyLicenceToken(token);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.email).toBe('buyer@acme.com');
      expect(r.issued).toBe('2026-06-07');
      expect(r.lid).toBe('amcp_test123');
    }
  });

  it('rejects a tampered payload (flipped byte)', () => {
    const token = signToken(validPayload(), devKey);
    const body = token.slice(LICENCE_TOKEN_PREFIX.length);
    const [p, s] = body.split('.') as [string, string];
    const bytes = base64urlDecode(p);
    bytes[0] = bytes[0]! ^ 0x01;
    const tampered = `${LICENCE_TOKEN_PREFIX}${base64urlEncode(bytes)}.${s}`;
    expect(verifyLicenceToken(tampered).valid).toBe(false);
  });

  it('rejects a bad signature (flipped sig byte)', () => {
    const token = signToken(validPayload(), devKey);
    const body = token.slice(LICENCE_TOKEN_PREFIX.length);
    const [p, s] = body.split('.') as [string, string];
    const sig = base64urlDecode(s);
    sig[0] = sig[0]! ^ 0x01;
    const bad = `${LICENCE_TOKEN_PREFIX}${p}.${base64urlEncode(sig)}`;
    expect(verifyLicenceToken(bad).valid).toBe(false);
  });

  it("rejects product !== 'desktop'", () => {
    const r = verifyLicenceToken(signToken(validPayload({ product: 'other' }), devKey));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/product/i);
  });

  it('rejects v !== 1', () => {
    const r = verifyLicenceToken(signToken(validPayload({ v: 2 }), devKey));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/version/i);
  });
});

describe('readLicence', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'affiliate-mcp-licence-'));
    originalEnv = process.env['AFFILIATE_MCP_CONFIG_DIR'];
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
    } else {
      process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns invalid with "No licence found." when the file is absent', () => {
    const r = readLicence();
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('No licence found.');
  });

  it.runIf(hasDevKey)('returns valid for a written, genuinely signed token', () => {
    const devKey = createPrivateKey(readFileSync(DEV_KEY_PATH, 'utf8'));
    const token = signToken(validPayload(), devKey);
    // Trailing newline/whitespace must be tolerated.
    writeFileSync(path.join(tmpDir, 'licence'), `${token}\n`, { mode: 0o600 });
    const r = readLicence();
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.email).toBe('buyer@acme.com');
      expect(r.issued).toBe('2026-06-07');
    }
  });
});
