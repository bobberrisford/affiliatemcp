/**
 * Unit tests for the browser-session cookie and CSRF helpers added for OAuth
 * slice 3 (`src/http.ts`): the exact `Set-Cookie` attribute string, robust
 * `Cookie`-header parsing, and the same-origin check's fail-closed posture.
 */

import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  clearSessionCookieHeader,
  cookieToken,
  sameOriginPost,
  setSessionCookieHeader,
} from '../src/http.js';
import type { Env } from '../src/env.js';

function envWith(publicBaseUrl: string | undefined): Env {
  // Only the fields these helpers read need to be present.
  return { PUBLIC_BASE_URL: publicBaseUrl } as unknown as Env;
}

function req(headers: Record<string, string>): Request {
  return new Request('https://hosted.test/connect/awin', { method: 'POST', headers });
}

describe('setSessionCookieHeader / clearSessionCookieHeader', () => {
  it('emits the exact HttpOnly; Secure; SameSite=Lax cookie with Path and Max-Age', () => {
    // Lax, not Strict: the magic link is opened cross-site (from an email
    // client), so a Strict cookie would be withheld on the callback's redirect
    // to /connect and the dashboard would re-prompt. See setSessionCookieHeader.
    expect(setSessionCookieHeader('amcps_abc.def', 2592000)).toBe(
      'hosted_session=amcps_abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000',
    );
  });

  it('clears with Max-Age=0 and the same attributes', () => {
    expect(clearSessionCookieHeader()).toBe(
      'hosted_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    );
  });

  it('exports the cookie name as hosted_session', () => {
    expect(SESSION_COOKIE_NAME).toBe('hosted_session');
  });
});

describe('cookieToken', () => {
  it('returns null with no Cookie header', () => {
    expect(cookieToken(new Request('https://hosted.test/'))).toBeNull();
  });

  it('reads hosted_session from a single-cookie header', () => {
    expect(cookieToken(req({ cookie: 'hosted_session=amcps_tok' }))).toBe('amcps_tok');
  });

  it('reads hosted_session among other cookies, tolerating whitespace', () => {
    expect(cookieToken(req({ cookie: 'a=1;  hosted_session=amcps_tok ; b=2' }))).toBe('amcps_tok');
  });

  it('returns null when the cookie is present but empty', () => {
    expect(cookieToken(req({ cookie: 'hosted_session=' }))).toBeNull();
  });

  it('does not match a differently-named cookie that contains the name as a substring', () => {
    expect(cookieToken(req({ cookie: 'not_hosted_session=nope' }))).toBeNull();
  });
});

describe('sameOriginPost', () => {
  const env = envWith('https://hosted.test');

  it('accepts a same-origin Origin header', () => {
    expect(sameOriginPost(req({ origin: 'https://hosted.test' }), env)).toBe(true);
  });

  it('rejects a cross-site Origin header', () => {
    expect(sameOriginPost(req({ origin: 'https://evil.example' }), env)).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(sameOriginPost(req({ referer: 'https://hosted.test/connect' }), env)).toBe(true);
    expect(sameOriginPost(req({ referer: 'https://evil.example/x' }), env)).toBe(false);
  });

  it('fails closed when both Origin and Referer are absent', () => {
    expect(sameOriginPost(req({}), env)).toBe(false);
  });

  it('fails closed when PUBLIC_BASE_URL is unusable', () => {
    expect(sameOriginPost(req({ origin: 'https://hosted.test' }), envWith(''))).toBe(false);
  });

  it('fails closed on an unparseable Referer', () => {
    expect(sameOriginPost(req({ referer: 'not a url' }), env)).toBe(false);
  });
});
