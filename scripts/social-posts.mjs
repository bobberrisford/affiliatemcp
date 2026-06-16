// Post definitions for scripts/social-video.mjs. One entry per LinkedIn post,
// built to the six-beat structure in docs/product/social-video-playbook.md.
// All data is scrubbed: placeholder brands (Acme / CashbackCo) and round demo
// numbers only. Never real account names, IDs, or totals.

const cta = (start, end) => ({
  id: 'cta', start, end, bg: 'paper',
  html: `<span class="kicker">Free &amp; open source</span>
    <div class="cta">Try it on your<br>own data.</div>
    <div class="sub" style="font-size:36px">Setup takes about five minutes. No code.</div>
    <div class="url">Link in the first comment ↓</div>`,
});

const end = (start, endT) => ({
  id: 'end', start, end: endT, bg: 'ink', wrap: 'endwrap',
  html: `<div class="cta" style="font-size:96px">Agentic<br>affiliate.</div>
    <div class="sub" style="font-size:34px;color:#9A9DAC">Your data stays on your machine.</div>
    {{MARK}}`,
});

export const POSTS = {
  'chase-unpaid-commissions': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="kicker">For publishers</span>
          <h1><span class="blue">Approved.</span><br>Still <span class="pink">not paid?</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<div class="sub">A network validated your commission 90+ days ago.</div>
          <div class="sub">It is still sitting unpaid, across every network you work with.</div>` },
      { id: 'ask', start: 7.4, end: 16.6, bg: 'ink',
        html: `<span class="kicker">Ask in plain English</span>
          <div class="bubble user"><span class="who">You</span>Which approved sales haven't been paid in 90 days?</div>` },
      { id: 'result', start: 16.6, end: 27.6, bg: 'ink',
        html: `<span class="kicker">Across every network</span>
          <div class="rows">
            <div class="row"><span class="net">Network A</span><span class="amt">£1,240 · 18 sales</span></div>
            <div class="row"><span class="net">Network B</span><span class="amt">£860 · 11 sales</span></div>
            <div class="row"><span class="net">Network C</span><span class="amt">£430 · 6 sales</span></div>
          </div>
          <div class="note">+ a drafted chase email per network. It drafts. You send.</div>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
  },

  'programme-performance-report': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="kicker">For brands &amp; agencies</span>
          <h1>The weekly.<br><span class="blue">Across every<br>network.</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<div class="sub">Your client wants the number by 9am.</div>
          <div class="sub">It lives in six dashboards, behind six logins.</div>` },
      { id: 'ask', start: 7.4, end: 16.0, bg: 'ink',
        html: `<span class="kicker">Ask in plain English</span>
          <div class="bubble user"><span class="who">You</span>How did Acme do this week?</div>` },
      { id: 'result', start: 16.0, end: 27.6, bg: 'ink',
        html: `<span class="kicker">Acme · this week vs last</span>
          <div class="big-num">+14%</div>
          <div class="rows">
            <div class="row"><span class="net">Top publisher</span><span class="amt">£12,400</span></div>
            <div class="row"><span class="net">Approved</span><span class="amt">82%</span></div>
            <div class="row"><span class="net">Pending</span><span class="amt">15%</span></div>
          </div>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
  },

  'programme-reversal-report': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="kicker">For brands &amp; agencies</span>
          <h1>Where's the<br>commission<br><span class="pink">leaking?</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<div class="sub">Conversions keep getting declined.</div>
          <div class="sub">Nobody can say exactly why, or how much it's costing.</div>` },
      { id: 'ask', start: 7.4, end: 16.0, bg: 'ink',
        html: `<span class="kicker">Ask in plain English</span>
          <div class="bubble user"><span class="who">You</span>Why are Acme's commissions being declined?</div>` },
      { id: 'result', start: 16.0, end: 27.6, bg: 'ink',
        html: `<span class="kicker">Reversals by reason · value at stake</span>
          <div class="rows">
            <div class="row"><span class="net">Cancelled order</span><span class="amt">£2,100</span></div>
            <div class="row"><span class="net">Duplicate</span><span class="amt">£640</span></div>
            <div class="row"><span class="net">Out of policy</span><span class="amt">£380</span></div>
          </div>
          <div class="note">Surfaces the leak. It does not change any transaction.</div>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
  },

  'publisher-performance-review': {
    scenes: [
      { id: 'hook', start: 0, end: 3.2, bg: 'ink',
        html: `<span class="kicker">For brands &amp; agencies</span>
          <h1>Partner call<br>in <span class="blue">10 minutes.</span></h1>` },
      { id: 'problem', start: 3.2, end: 7.4, bg: 'ink',
        html: `<div class="sub">You need the numbers and the story behind them.</div>
          <div class="sub">Not a CSV export you have to read in the lift.</div>` },
      { id: 'ask', start: 7.4, end: 16.0, bg: 'ink',
        html: `<span class="kicker">Ask in plain English</span>
          <div class="bubble user"><span class="who">You</span>Prep me for the call with CashbackCo on Acme.</div>` },
      { id: 'result', start: 16.0, end: 27.6, bg: 'ink',
        html: `<span class="kicker">CashbackCo on Acme · last 30 days</span>
          <div class="rows">
            <div class="row"><span class="net">EPC</span><span class="amt">£0.48</span></div>
            <div class="row"><span class="net">Avg order value</span><span class="amt">£72</span></div>
            <div class="row"><span class="net">Conversions</span><span class="amt">↑ 9% vs prior</span></div>
          </div>
          <div class="note">+ talking points for the call.</div>` },
      cta(27.6, 33.4),
      end(33.4, 36.4),
    ],
  },
};
