/**
 * Licence email delivery. Behind a single `sendLicenceEmail` function so the
 * provider (Resend today, Postmark tomorrow) can be swapped without touching
 * the Worker. If `RESEND_API_KEY` is unset (local dev) we log instead of
 * failing — the licence is still stored in KV and shown on /success.
 */

import type { Env } from './env.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Build the plain-text + HTML body for a licence email. The deep-link lets a
 * non-technical buyer hand the key straight back to the app.
 */
function buildEmailBody(token: string): { text: string; html: string } {
  const deepLink = `affiliate-mcp://activate?key=${encodeURIComponent(token)}`;
  const text = [
    'Your affiliate-mcp desktop licence',
    '',
    'Thank you for buying affiliate-mcp desktop. Your lifetime licence key:',
    '',
    token,
    '',
    'To activate: open the app, go to the Activate screen, and paste the key.',
    `Or click this link on the machine with the app installed: ${deepLink}`,
    '',
    'Keep this email — the key works forever and offline.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<body style="font-family:'JetBrains Mono',ui-monospace,monospace;background:#fff;color:#0a0a0a;margin:0;padding:24px;">
  <h1 style="font-size:18px;font-weight:700;margin:0 0 16px;">your affiliate-mcp desktop licence</h1>
  <p style="font-size:14px;line-height:1.5;">Thank you for buying affiliate-mcp desktop. Your lifetime licence key:</p>
  <pre style="background:#f4f4f4;border:2px solid #0a0a0a;padding:12px;font-size:13px;white-space:pre-wrap;word-break:break-all;">${token}</pre>
  <p style="font-size:14px;line-height:1.5;">To activate: open the app, go to the Activate screen, and paste the key.</p>
  <p style="font-size:14px;line-height:1.5;">
    <a href="${deepLink}" style="display:inline-block;background:#2B2BFF;color:#fff;text-decoration:none;padding:10px 16px;border:2px solid #0a0a0a;font-weight:700;">activate in the app</a>
  </p>
  <p style="font-size:12px;color:#555;">Keep this email — the key works forever and offline.</p>
</body>
</html>`;

  return { text, html };
}

/**
 * Send the licence by email. Resolves true on success / dev-log, false on a
 * provider error (caller decides whether that's fatal — for the webhook it is
 * not, since the key is already in KV and recoverable via /resend).
 */
export async function sendLicenceEmail(env: Env, email: string, token: string): Promise<boolean> {
  const { text, html } = buildEmailBody(token);

  if (!env.RESEND_API_KEY) {
    // Local dev / unconfigured: log instead of failing.
    console.log(
      `[email:dev] RESEND_API_KEY unset — would send licence to ${email}\n${text}`,
    );
    return true;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.LICENCE_FROM_EMAIL,
        to: [email],
        subject: 'Your affiliate-mcp desktop licence',
        text,
        html,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[email] Resend failed ${res.status}: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[email] Resend threw: ${(err as Error).message}`);
    return false;
  }
}
