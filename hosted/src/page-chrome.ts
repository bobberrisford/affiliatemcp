/**
 * Shared design-system chrome for every server-rendered hosted page (the
 * connect dashboard, billing, the OAuth ceremony, and the sign-in error page).
 *
 * This replaces the three near-identical throwaway "minimal monospace card"
 * styles that each of those files used to carry inline. Those were deliberately
 * disposable; this is the deliberate opposite — one implementation of the
 * affiliate-mcp design system (see `design-system/` and the marketing site
 * `site/hosted.html`, which shares these exact tokens and components), so the
 * hosted flow looks like the same product a user just signed up for on the
 * site.
 *
 * SELF-CONTAINED BY DESIGN. These pages carry credentials and OAuth consent, so
 * they load NO external resources: no external stylesheet, no CDN, no web font.
 * The brand's display/mono fonts (Bricolage Grotesque, Space Grotesk, JetBrains
 * Mono) are therefore NOT fetched here — the design tokens' documented system
 * fallbacks render instead. Everything else (the locked palette, hard cards,
 * solid offset shadows, lowercase display headings, mono labels, the blue
 * accent) is reproduced exactly, so the page still reads as the brand while
 * staying a single self-contained HTML document. If a page ever needs the real
 * web fonts, that is a separate, deliberate decision about loading a font on a
 * credential page, not a default.
 */

import { html } from './http.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The design system, inlined and self-contained. Tokens and component styles
 * mirror `design-system/` and `site/hosted.html`; only the web-font `@font-face`
 * / `@import` is omitted (see the file header), so the documented fallback
 * stacks render.
 */
const DESIGN_CSS = `
  :root{
    --ink:#0B0B0C; --ink-soft:#16161B; --paper:#FFFFFF; --paper-2:#F2F3F7;
    --smudge:#8B8FA0; --smudge-dk:#565A6B;
    --blue:#2B2BFF; --blue-deep:#1B1BB8; --blue-bright:#5A78FF; --magenta:#FF2E88;
    --pending:#E8A317;
    --line:rgba(11,11,12,0.14); --line-strong:rgba(11,11,12,0.85);
    --shadow:4px 4px 0 0 var(--ink); --shadow-lg:6px 6px 0 0 var(--ink);
    --font-display:'Bricolage Grotesque','Arial Black',system-ui,sans-serif;
    --font-sans:'Space Grotesk',system-ui,-apple-system,sans-serif;
    --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
  }
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--paper);color:var(--ink);font-family:var(--font-sans);
    font-size:1.0625rem;line-height:1.55;-webkit-font-smoothing:antialiased}

  .topbar{border-bottom:2px solid var(--ink);background:var(--paper)}
  .topbar .inner{max-width:680px;margin:0 auto;padding:14px 20px;display:flex;align-items:center}
  .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}
  .brand svg{width:30px;height:30px;display:block}
  .brand .wm{font-family:var(--font-display);font-weight:800;font-size:1.18rem;
    letter-spacing:-.03em;line-height:1;text-transform:lowercase}
  .brand .wm .mcp{background:var(--blue);color:var(--paper);padding:0 5px;border-radius:3px}

  main.wrap{max-width:680px;margin:0 auto;padding:32px 20px 64px}
  .card{background:var(--paper);border:2px solid var(--ink);border-radius:8px;
    padding:28px;box-shadow:var(--shadow-lg)}

  h1{font-family:var(--font-display);font-weight:800;font-size:1.9rem;line-height:1.02;
    letter-spacing:-.02em;text-transform:lowercase;margin:0 0 6px}
  h2{font-family:var(--font-display);font-weight:800;font-size:1.25rem;line-height:1.1;
    letter-spacing:-.01em;text-transform:lowercase;margin:22px 0 8px}
  p{margin:0 0 1em;max-width:60ch}
  ol,ul{max-width:60ch}
  ol li,ul li{margin:0 0 .4em}
  strong{font-weight:700}
  .muted{color:var(--smudge-dk)}
  .small{font-size:.875rem}

  a{color:var(--ink);text-decoration:none;
    background-image:linear-gradient(var(--blue),var(--blue));
    background-size:100% .12em;background-position:0 92%;background-repeat:no-repeat;
    transition:background-size .12s ease,color .12s ease}
  a:hover{background-size:100% 100%;color:var(--paper)}

  code{font-family:var(--font-mono);font-size:.92em;background:var(--ink);
    color:var(--blue-bright);padding:.12em .4em;border-radius:3px;word-break:break-all}

  label{display:block;font-family:var(--font-mono);font-weight:700;font-size:.8rem;
    letter-spacing:.04em;margin:16px 0 4px}
  .field-help{font-size:.82rem;color:var(--smudge-dk);margin:2px 0 6px;max-width:60ch}
  input[type="text"],input[type="password"],input[type="email"]{
    width:100%;font-family:var(--font-mono);font-size:.95rem;padding:11px 12px;
    border:2px solid var(--ink);background:var(--paper);color:var(--ink);border-radius:6px}
  input:focus{outline:3px solid var(--blue-bright);outline-offset:1px}

  button,.btn{font-family:var(--font-mono);font-weight:700;font-size:.82rem;
    letter-spacing:.04em;text-transform:uppercase;padding:11px 16px;
    border:2px solid var(--ink);border-radius:6px;cursor:pointer;background:var(--paper);
    color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:8px;
    margin-top:14px;transition:transform .08s steps(2),box-shadow .08s steps(2)}
  button.p,.btn.p{background:var(--blue);color:var(--paper);border-color:var(--ink);box-shadow:var(--shadow)}
  button.p:active,.btn.p:active{transform:translate(4px,4px);box-shadow:0 0 0}
  button.sm,.btn.sm{padding:7px 11px;font-size:.72rem;margin-top:0}
  button.ghost,.btn.ghost{background:var(--paper);color:var(--ink)}
  a.btn:hover{color:var(--ink)}
  a.btn.p:hover{color:var(--paper)}

  form.nav,form.inline{display:inline-block;margin:0 8px 0 0}

  .note{border:2px dashed var(--line-strong);border-radius:6px;padding:12px 14px;
    font-size:.9rem;margin:16px 0;max-width:60ch}

  .chip{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-mono);
    font-weight:700;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
    background:var(--ink);color:var(--paper);padding:5px 9px;border-radius:3px}

  ul.network-list{list-style:none;padding:0;margin:18px 0}
  ul.network-list li{border:2px solid var(--ink);border-radius:6px;padding:12px 14px;
    margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px}
  ul.network-list li>span:first-child{font-weight:500}
  .status-connected{color:var(--blue);font-family:var(--font-mono);font-weight:700;font-size:.8rem}
  .status-not-connected{color:var(--smudge-dk);font-family:var(--font-mono);font-size:.8rem}
  .status-failed{color:var(--magenta);font-family:var(--font-mono);font-weight:700;font-size:.8rem}
`;

/** The affiliate-mcp prompt mark + wordmark, matching `site/hosted.html`. Links
 * to the marketing site so a signed-in user can always get back to it. */
function brandHeader(siteOrigin: string): string {
  return `<header class="topbar"><div class="inner">
    <a class="brand" href="${escapeHtml(siteOrigin)}">
      <svg viewBox="0 0 120 120" aria-hidden="true"><rect width="120" height="120" rx="14" fill="#2B2BFF"></rect><polyline points="34,38 58,60 34,82" fill="none" stroke="#fff" stroke-width="13"></polyline><rect x="66" y="68" width="24" height="14" fill="#fff"></rect></svg>
      <span class="wm">agentic <span class="mcp">affiliate</span></span>
    </a>
  </div></header>`;
}

/**
 * Render a full hosted page in the design system: brand header + a single card
 * holding `bodyHtml`. `no-store` comes from `html()`; `no-referrer` is added
 * here because pages in the connect and OAuth flows embed short-lived tokens in
 * hidden fields and link out to external docs — the Referer must never leak.
 * `siteOrigin` defaults to the production marketing site.
 */
export function renderShell(
  title: string,
  bodyHtml: string,
  status = 200,
  siteOrigin = 'https://agenticaffiliate.ai',
): Response {
  const res = html(
    `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DESIGN_CSS}</style></head>
<body>${brandHeader(siteOrigin)}<main class="wrap"><div class="card">${bodyHtml}</div></main></body></html>`,
    status,
  );
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}
