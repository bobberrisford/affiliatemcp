// Post definitions for scripts/social-video.mjs. One entry per LinkedIn post,
// built to the six-beat structure in docs/product/social-video-playbook.md and
// composed entirely from design-system classes (.mega, .h1, .label, .lead,
// .hl/.hl-mag, .term, .data-table, .status, .card, .btn). All data is scrubbed:
// placeholder brands (Acme / CashbackCo) and round demo numbers only.

// A Claude-style terminal block (the design system's "product surface").
const term = (title, bodyHtml) => `
  <div class="term" style="font-size:1.05rem">
    <div class="bar">
      <i style="background:var(--smudge)"></i>
      <i style="background:var(--blue)"></i>
      <i style="background:var(--magenta)"></i>
      <span class="t">${title}</span>
    </div>
    <div class="body">${bodyHtml}</div>
  </div>`;

const ask = (q) => term('claude · affiliate-mcp', `<span class="pr">&gt;</span> ${q}`);

// Standard CTA beat: website-style buttons on paper.
const cta = (start, end) => ({
  id: 'cta', start, end, bg: 'paper',
  html: `<span class="label">free &amp; open source</span>
    <h2 class="h1">try it on your own data.</h2>
    <p class="lead muted">setup takes about five minutes. no code.</p>
    <div class="btns">
      <span class="btn btn-primary">Claude extension</span>
      <span class="btn btn-dark">Desktop app</span>
    </div>
    <p class="mono small" style="color:var(--blue)">link in the first comment ↓</p>`,
});

const end = (start, endT) => ({
  id: 'end', start, end: endT, bg: 'ink', wrap: 'endwrap',
  html: `<h1 class="mega">agentic<br>affiliate.</h1>
    <span class="label muted">your data stays on your machine</span>
    {{MARK}}`,
});

// A data-table row with a status dot.
const row = (net, amt, dot, status) =>
  `<tr><td class="net">${net}</td><td class="num">${amt}</td>
    <td><span class="status"><span class="dot ${dot}"></span>${status}</span></td></tr>`;

export const POSTS = {
  'chase-unpaid-commissions': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="label">for publishers</span>
          <h1 class="mega">approved.<br>still <span class="hl-mag">not paid?</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<span class="label">the problem</span>
          <p class="lead">a network validated your commission 90+ days ago.</p>
          <p class="lead muted">it is still sitting unpaid, across every network you work with.</p>` },
      { id: 'ask', start: 7.4, end: 16.6, bg: 'ink',
        html: `<span class="label">ask in plain english</span>
          ${ask("Which approved sales haven't been paid in 90 days?")}` },
      { id: 'result', start: 16.6, end: 27.6, bg: 'ink',
        html: `<span class="label">across every network</span>
          <table class="data-table" style="font-size:1.05rem">
            ${row('Network A', '£1,240 · 18 sales', 'dot-pending', 'unpaid')}
            ${row('Network B', '£860 · 11 sales', 'dot-pending', 'unpaid')}
            ${row('Network C', '£430 · 6 sales', 'dot-pending', 'unpaid')}
          </table>
          <p class="mono" style="color:var(--pending)">+ a drafted chase email per network. it drafts. you send.</p>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
  },

  'programme-performance-report': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="label">for brands &amp; agencies</span>
          <h1 class="mega">the weekly.<br><span class="hl">across every<br>network.</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<span class="label">the problem</span>
          <p class="lead">your client wants the number by 9am.</p>
          <p class="lead muted">it lives in six dashboards, behind six logins.</p>` },
      { id: 'ask', start: 7.4, end: 16.0, bg: 'ink',
        html: `<span class="label">ask in plain english</span>
          ${ask('How did Acme do this week?')}` },
      { id: 'result', start: 16.0, end: 27.6, bg: 'ink',
        html: `<span class="label">acme · this week vs last</span>
          <div class="card">
            <div class="top"><span class="sub">net commission</span><span class="delta">▲ 14% vs last week</span></div>
            <div class="amt">£48.2k</div>
          </div>
          <table class="data-table" style="font-size:1.05rem">
            ${row('Top publisher', '£12,400', 'dot-pos', 'approved')}
            ${row('Approved', '82%', 'dot-pos', 'paid soon')}
            ${row('Pending', '15%', 'dot-pending', 'pending')}
          </table>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
  },

  'programme-reversal-report': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="label">for brands &amp; agencies</span>
          <h1 class="mega">where's the<br>commission<br><span class="hl-mag">leaking?</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<span class="label">the problem</span>
          <p class="lead">conversions keep getting declined.</p>
          <p class="lead muted">nobody can say exactly why, or how much it is costing.</p>` },
      { id: 'ask', start: 7.4, end: 16.0, bg: 'ink',
        html: `<span class="label">ask in plain english</span>
          ${ask("Why are Acme's commissions being declined?")}` },
      { id: 'result', start: 16.0, end: 27.6, bg: 'ink',
        html: `<span class="label">reversals by reason · value at stake</span>
          <table class="data-table" style="font-size:1.05rem">
            ${row('Cancelled order', '£2,100', 'dot-neg', 'reversed')}
            ${row('Duplicate', '£640', 'dot-neg', 'reversed')}
            ${row('Out of policy', '£380', 'dot-neg', 'reversed')}
          </table>
          <p class="mono" style="color:var(--pending)">surfaces the leak. it does not change any transaction.</p>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
    poster: `<div class="ptop">
        <span class="label">for brands &amp; agencies</span>
        <h1 class="h1">where's the commission <span class="hl-mag">leaking?</span></h1>
        <p class="lead muted">reversals on acme, last 30 days, by reason and value at stake.</p>
        <table class="data-table" style="font-size:1.05rem">
          ${row('Cancelled order', '£2,100', 'dot-neg', 'reversed')}
          ${row('Duplicate', '£640', 'dot-neg', 'reversed')}
          ${row('Out of policy', '£380', 'dot-neg', 'reversed')}
        </table>
        <p class="mono" style="color:var(--pending)">surfaces the leak. it does not change any transaction.</p>
      </div>
      <div class="pbot">{{MARK}}<p class="foot">free &amp; open source · link in the comments ↓</p></div>`,
  },

  'publisher-performance-review': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="label">for brands &amp; agencies</span>
          <h1 class="mega">partner call<br>in <span class="hl">10 minutes.</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<span class="label">the problem</span>
          <p class="lead">you need the numbers and the story behind them.</p>
          <p class="lead muted">not a csv export you read in the lift.</p>` },
      { id: 'ask', start: 7.4, end: 16.0, bg: 'ink',
        html: `<span class="label">ask in plain english</span>
          ${ask('Prep me for the call with CashbackCo on Acme.')}` },
      { id: 'result', start: 16.0, end: 27.6, bg: 'ink',
        html: `<span class="label">cashbackco on acme · last 30 days</span>
          <table class="data-table" style="font-size:1.05rem">
            ${row('EPC', '£0.48', 'dot-pos', 'up')}
            ${row('Avg order value', '£72', 'dot-pos', 'steady')}
            ${row('Conversions', '↑ 9% vs prior', 'dot-pos', 'up')}
          </table>
          <p class="mono" style="color:var(--blue-bright)">+ talking points for the call.</p>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
    poster: `<div class="ptop">
        <span class="label">for brands &amp; agencies</span>
        <h1 class="h1">prep for the partner call <span class="hl">in minutes.</span></h1>
        <p class="lead muted">cashbackco on acme, last 30 days, with talking points.</p>
        <table class="data-table" style="font-size:1.05rem">
          ${row('EPC', '£0.48', 'dot-pos', 'up')}
          ${row('Avg order value', '£72', 'dot-pos', 'steady')}
          ${row('Conversions', '↑ 9% vs prior', 'dot-pos', 'up')}
        </table>
        <p class="mono" style="color:var(--blue-bright)">+ talking points for the call.</p>
      </div>
      <div class="pbot">{{MARK}}<p class="foot">free &amp; open source · link in the comments ↓</p></div>`,
  },
};
