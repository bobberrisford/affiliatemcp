/**
 * Billing/account page in the connect UI (Stripe-wiring follow-up to H6,
 * `docs/product/hosted-mvp-workstream.md`): a server-rendered, session-gated
 * page showing the caller's current tier and status, with buttons to
 * subscribe, upgrade, or manage a subscription. Same minimal style, same
 * no-client-framework constraint, and the SAME session model as the rest of
 * the H5 connect flow (slice 3): the browser authenticates via the HttpOnly
 * `hosted_session` cookie, never a token in a URL, body, or page. This file
 * does not re-implement that; it reuses `resolveBrowserSession`,
 * `maybeFormData`, `page`, `navForm`, `escapeHtml`, `csrfErrorPage`, and
 * `signInPromptPage` from `./connect.ts` verbatim, so "what counts as signed
 * in", "how a navigation form is built", and the CSRF posture cannot drift
 * between the two files. See `./connect.ts`'s file header for the full
 * cookie/CSRF reasoning this page inherits unchanged. The two state-changing
 * POSTs here (checkout and portal) carry the same `sameOriginPost` CSRF check
 * as the connect credential POST.
 *
 *   GET|POST /connect/billing            current tier/status + action buttons
 *   POST     /connect/billing/checkout   { tier } -> Stripe Checkout redirect
 *   POST     /connect/billing/portal     -> Stripe Billing Portal redirect
 *
 * The router (`src/index.ts`) must match `/connect/billing` and its two
 * sub-paths BEFORE the generic `/connect/:network` patterns in
 * `./connect.ts`: "billing" is not a hosted-eligible network slug, and
 * without that ordering it would fall through to `findConnectNetwork`'s
 * "network not found" page instead of this one.
 *
 * Checkout and portal both call the EXISTING JSON API handlers
 * (`handleBillingCheckout`, `handleBillingPortal`, `./billing.ts`) directly,
 * in-process, not over the network, and not duplicating their Stripe logic a
 * second time. Each builds a synthetic same-process `Request` carrying the
 * already-resolved session as an `Authorization` header: that header exists
 * only inside this Worker's own call stack for the duration of one function
 * call and is never sent over the wire or placed in a URL the browser (or
 * Cloudflare's request logs) can see. The JSON handler's `{ url }` response
 * becomes an HTTP 303 redirect back to the browser, which is the only way a
 * plain HTML form can hand off to Stripe Checkout/Portal without
 * JavaScript.
 *
 * Stripe-return honesty, stated once here (see `hosted/README.md`, "Billing
 * (Stripe checkout, portal, and the billing page)", for the user-facing
 * version): `BILLING_SUCCESS_URL`/`BILLING_CANCEL_URL`/
 * `BILLING_PORTAL_RETURN_URL` (`src/env.ts`) should point back at this page
 * (`GET /connect/billing`, optionally with a `?checkout=success` or
 * `?checkout=cancelled` status flag, a plain, non-sensitive marker, not a
 * token). With the `SameSite=Lax` session cookie, Stripe's return is a
 * top-level GET navigation that carries the session, so the caller normally
 * lands back here signed in and sees their real plan. This page never trusts
 * the redirect itself: it does not invent a session, silently poll Stripe, or
 * fabricate a "you're subscribed" result from the `checkout` flag.
 * `GET /billing/entitlement` (read in-process here via `resolveEntitlement`) is
 * the only source of truth for what actually happened. If the session is
 * genuinely absent, it falls back to the ordinary sign-in prompt with one
 * honest line describing what the `checkout` flag claims.
 */

import type { Env } from '../env.js';
import { sameOriginPost } from '../http.js';
import type { Entitlement, HostedTier } from '../billing.js';
import { resolveEntitlement } from '../billing.js';
import { handleBillingCheckout, handleBillingPortal } from './billing.js';
import {
  csrfErrorPage,
  escapeHtml,
  maybeFormData,
  navForm,
  page,
  resolveBrowserSession,
  signInPromptPage,
  type BrowserSession,
} from './connect.js';

/**
 * Build a `Request` that exists only to satisfy `handleBillingCheckout`/
 * `handleBillingPortal`'s own signatures: its URL is never dereferenced,
 * only its headers and body are read. The `Authorization` header carries the
 * session this page ALREADY resolved from the browser's own POST body or
 * header; nothing here reads a second credential from anywhere.
 */
function syntheticApiRequest(path: string, token: string, body: unknown): Request {
  return new Request(`https://internal.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** A same-worker 303 redirect to a Stripe-hosted URL. `no-store` matches every
 * page in this flow; `no-referrer` (stricter than the flow-wide `same-origin`)
 * is used here specifically because this hop is cross-origin to Stripe and must
 * leak no `Referer` there — a redirect response hosts no form, so it never needs
 * the `Origin`-header behaviour that made `same-origin` necessary elsewhere. */
function redirectTo(url: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: url,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function readUrlFromApiResponse(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => ({}))) as { url?: unknown };
  if (res.status !== 200 || typeof body.url !== 'string' || body.url.length === 0) return null;
  return body.url;
}

function tierLabel(tier: HostedTier): string {
  if (tier === 'solo') return 'Solo';
  if (tier === 'pro') return 'Pro';
  return 'none';
}

function renderBillingActions(entitlement: Entitlement): string {
  if (entitlement.tier === 'none') {
    return `
      ${navForm('/connect/billing/checkout', 'Subscribe Solo: £34/month', { tier: 'solo' }, 'p')}
      ${navForm('/connect/billing/checkout', 'Subscribe Pro: £99/month', { tier: 'pro' }, 'p')}
    `;
  }
  if (entitlement.tier === 'solo') {
    // Upgrade Solo -> Pro reuses the same checkout route with the higher-tier
    // price: Stripe's subscription-mode Checkout replaces the existing
    // subscription's price on the next invoice rather than starting a second
    // one, provided the Solo and Pro Prices share one Product in the Stripe
    // dashboard (a Rob-side dashboard setting, documented in
    // hosted/README.md, not something this Worker configures). "Manage
    // subscription" (the portal) is the fallback the task also asks for, and
    // is offered here regardless, in case the dashboard is not set up that
    // way yet.
    return `
      ${navForm('/connect/billing/checkout', 'Upgrade to Pro: £99/month', { tier: 'pro' }, 'p')}
      ${navForm('/connect/billing/portal', 'Manage subscription')}
    `;
  }
  // pro: nothing higher to subscribe to. Manage (the portal) is the only action.
  return navForm('/connect/billing/portal', 'Manage subscription');
}

async function renderBillingPage(env: Env, session: BrowserSession, noteMessage?: string): Promise<Response> {
  const entitlement = await resolveEntitlement(env.HOSTED_BILLING, session.userId);
  const noteHtml = noteMessage ? `<div class="note">${escapeHtml(noteMessage)}</div>` : '';

  return page(
    'billing',
    `
    <h1>billing</h1>
    <p>${navForm('/connect', 'back to all networks')}</p>
    ${noteHtml}
    <p>Current plan: <strong>${escapeHtml(tierLabel(entitlement.tier))}</strong>
    <span class="muted">(status: ${escapeHtml(entitlement.status)})</span></p>
    ${renderBillingActions(entitlement)}
    <p class="muted">Solo is £34/month; Pro is £99/month. Subscribing and
    managing your plan both open Stripe's own secure checkout and billing
    pages, where you can change tier, update your card, or cancel at any time.
    Card details go straight to Stripe; they are never entered or stored here.</p>
  `,
  );
}

/** A `checkout` query-flag value is a plain, non-sensitive marker Stripe's
 * redirect carries (never a session token). This note is shown only on the
 * signed-out fallback (see the file header); a signed-in return renders the
 * billing page directly. */
function checkoutStatusNote(checkoutStatus: string | null): string | undefined {
  if (checkoutStatus === 'success') {
    return 'Stripe reports checkout is complete. Sign in above to see your updated plan.';
  }
  if (checkoutStatus === 'cancelled') {
    return 'Checkout was cancelled. Nothing was charged.';
  }
  return undefined;
}

// ── GET|POST /connect/billing ────────────────────────────────────────────
export async function handleBillingPage(request: Request, env: Env): Promise<Response> {
  const session = await resolveBrowserSession(request, env);
  if (!session) {
    const checkoutStatus = new URL(request.url).searchParams.get('checkout');
    return signInPromptPage(env, checkoutStatusNote(checkoutStatus));
  }
  return renderBillingPage(env, session);
}

// ── POST /connect/billing/checkout ───────────────────────────────────────
export async function handleBillingPageCheckout(request: Request, env: Env): Promise<Response> {
  const form = await maybeFormData(request);
  const session = await resolveBrowserSession(request, env);
  if (!session) return signInPromptPage(env);
  // CSRF defence in depth (same posture as the connect credential POST): a
  // billing action is state-changing, so it requires a same-origin request on
  // top of the cookie's SameSite=Lax protection.
  if (!sameOriginPost(request, env)) return csrfErrorPage();

  const tier = form?.get('tier');
  if (tier !== 'solo' && tier !== 'pro') {
    return renderBillingPage(env, session, 'Choose Solo or Pro to subscribe. Nothing was submitted to Stripe.');
  }

  const apiRequest = syntheticApiRequest('/billing/checkout', session.token, { tier });
  const apiResponse = await handleBillingCheckout(apiRequest, env, {});
  const url = await readUrlFromApiResponse(apiResponse);
  if (!url) {
    return renderBillingPage(env, session, 'Could not start checkout with Stripe. Nothing was charged. Try again.');
  }
  return redirectTo(url);
}

// ── POST /connect/billing/portal ─────────────────────────────────────────
export async function handleBillingPagePortal(request: Request, env: Env): Promise<Response> {
  const session = await resolveBrowserSession(request, env);
  if (!session) return signInPromptPage(env);
  if (!sameOriginPost(request, env)) return csrfErrorPage();

  const apiRequest = syntheticApiRequest('/billing/portal', session.token, {});
  const apiResponse = await handleBillingPortal(apiRequest, env, {});
  const url = await readUrlFromApiResponse(apiResponse);
  if (!url) {
    return renderBillingPage(
      env,
      session,
      'Could not open the Stripe billing portal. Subscribe first if you have not yet, or try again.',
    );
  }
  return redirectTo(url);
}
