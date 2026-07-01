// @ts-check
/* affiliate-mcp desktop — renderer (vanilla, framework-free).
   A small screen state-machine. Talks to window.affiliate (preload) when
   present; falls back to an in-file mock so it runs in a plain browser too.
   All visuals use the design-system component classes — no bespoke buttons. */

const MARK = '../../design-system/assets/mark.svg';

/* ---- API: real bridge or browser mock -------------------------------- */
const MOCK_NETWORKS = [
  { slug: 'awin', name: 'Awin', side: 'brand', setupMinutes: 3, approval: false },
  { slug: 'impact', name: 'Impact', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'partnerize', name: 'Partnerize', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'cj', name: 'CJ', side: 'publisher', setupMinutes: 3, approval: false },
  { slug: 'rakuten', name: 'Rakuten Advertising', side: 'publisher', setupMinutes: 5, approval: true },
  { slug: 'skimlinks', name: 'Skimlinks', side: 'publisher', setupMinutes: 2, approval: false },
  { slug: 'tradedoubler', name: 'Tradedoubler', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'sovrn-commerce', name: 'Sovrn Commerce', side: 'publisher', setupMinutes: 3, approval: false },
  { slug: 'everflow', name: 'Everflow', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'mrge', name: 'mrge', side: 'publisher', setupMinutes: 3, approval: false },
  { slug: 'ebay', name: 'eBay Partner Network', side: 'publisher', setupMinutes: 5, approval: true },
  { slug: 'admitad', name: 'Admitad', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'adtraction', name: 'Adtraction', side: 'publisher', setupMinutes: 3, approval: false },
  { slug: 'daisycon', name: 'Daisycon', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'kwanko', name: 'Kwanko', side: 'publisher', setupMinutes: 4, approval: false },
  { slug: 'adservice', name: 'Adservice', side: 'publisher', setupMinutes: 3, approval: false },
  { slug: 'flexoffers', name: 'FlexOffers', side: 'publisher', setupMinutes: 4, approval: true },
  { slug: 'indoleads', name: 'Indoleads', side: 'publisher', setupMinutes: 3, approval: false },
  { slug: 'coupang-partners', name: 'Coupang Partners', side: 'publisher', setupMinutes: 5, approval: true },
  { slug: 'awin-advertiser', name: 'Awin (advertiser)', side: 'brand', setupMinutes: 4, approval: false },
  { slug: 'cj-advertiser', name: 'CJ (advertiser)', side: 'brand', setupMinutes: 4, approval: false, multiBrand: true },
  { slug: 'impact-advertiser', name: 'Impact (advertiser)', side: 'brand', setupMinutes: 5, approval: false },
  { slug: 'partnerize-advertiser', name: 'Partnerize (advertiser)', side: 'brand', setupMinutes: 5, approval: false },
  { slug: 'partnerstack-advertiser', name: 'PartnerStack (advertiser)', side: 'brand', setupMinutes: 4, approval: false },
  { slug: 'rewardful', name: 'Rewardful (advertiser)', side: 'brand', setupMinutes: 3, approval: false },
  { slug: 'tradedoubler-advertiser', name: 'Tradedoubler (advertiser)', side: 'brand', setupMinutes: 5, approval: false },
  { slug: 'webgains-advertiser', name: 'Webgains (advertiser)', side: 'brand', setupMinutes: 4, approval: true },
  { slug: 'commission-factory-advertiser', name: 'Commission Factory (advertiser)', side: 'brand', setupMinutes: 4, approval: false },
];
const MOCK_STEPS = {
  cj: [{ field: 'CJ_PERSONAL_ACCESS_TOKEN', label: 'Personal access token', type: 'password', description: 'In the CJ dashboard, open Account → Web Services and copy your Personal Access Token. It’s a long string starting with a few letters.', deepLink: 'https://developers.cj.com/account/personal-access-tokens', example: 'by_kf93…' }],
  awin: [{ field: 'AWIN_API_TOKEN', label: 'OAuth2 token', type: 'password', description: 'In Awin, open Toolbox → API credentials and create an OAuth2 token. Paste it here.', deepLink: 'https://ui.awin.com/awin-api', example: 'a1b2c3…' }],
  impact: [{ field: 'IMPACT_ACCOUNT_SID', label: 'Account SID', type: 'text', description: 'In Impact, open Settings → API. Copy the Account SID. (Auth token comes next.)', deepLink: 'https://app.impact.com', example: 'IRxxxxAbc…' }],
  partnerize: [{ field: 'PARTNERIZE_USER_API_KEY', label: 'User API key', type: 'password', description: 'In Partnerize, open User Settings → API credentials and copy your User API key.', deepLink: 'https://console.partnerize.com', example: 'pz_live_…' }],
};
const MOCK_IDENTITY = { cj: 'Acme Media · publisher 7283190', awin: 'Acme Outdoors', impact: 'Acme Media', partnerize: 'Acme Media' };
const MOCK_BRANDS = [
  { id: 'b1', name: 'Acme Outdoors', status: 'active' },
  { id: 'b2', name: 'Northwind Home', status: 'active' },
  { id: 'b3', name: 'Globex Trial', status: 'pending' },
];
function mockApi() {
  const wait = (v, ms = 350) => new Promise((r) => setTimeout(() => r(v), ms));
  return {
    detectClients: () => wait({ desktop: 'present', desktopConfigPath: '~/Library/Application Support/Claude/claude_desktop_config.json' }),
    listNetworks: () => wait(MOCK_NETWORKS),
    setupSteps: (slug) => wait(MOCK_STEPS[slug] || []),
    validateField: (_slug, _field, value) => {
      // Preview-only heuristic so the ✓/✗ behaviour is visible in the browser.
      // A plausible-looking value (>= 8 non-space chars) passes; anything
      // shorter fails with a clear message. The real check lives in the core.
      const v = typeof value === 'string' ? value.trim() : '';
      return wait(v.length >= 8
        ? { ok: true, message: 'format looks right' }
        : { ok: false, message: 'that looks too short — copy the full value' }, 300);
    },
    verifyAuth: (slug, _values) => wait({ ok: true, identity: MOCK_IDENTITY[slug] || 'your account' }, 800),
    // cj-advertiser is multi-brand but has no list endpoint (NotImplementedError
    // → []), so the preview exercises the manual-entry path; others return a list.
    discoverBrands: (slug) => wait(slug === 'cj-advertiser' ? [] : MOCK_BRANDS, 500),
    saveEnv: (_entries) => wait({ ok: true }),
    getTelemetryConsent: () => wait({ ok: true, consent: 'unset' }),
    setTelemetryConsent: (enabled) => wait({ ok: true, enabled }),
    saveBrands: (_network, selections) => wait({ ok: true, count: (selections || []).length }),
    // Cockpit preview: a configured summary so the dashboard renders in a plain
    // browser. The real summary comes from the network reads via main.
    cockpitSummary: () => wait({
      ok: true,
      summary: {
        generatedAt: new Date().toISOString(),
        network: 'awin',
        configured: true,
        headline: {
          totalEarnings: 4218.55, currency: 'GBP',
          byStatus: { pending: 1290.4, approved: 2680.15, reversed: 88.0, paid: 160.0, other: 0, currency: 'GBP' },
          periodFrom: '2026-05-30', periodTo: '2026-06-29',
        },
        flags: [
          { kind: 'unpaid_over_threshold', severity: 'warning', title: 'GBP 1290.40 unpaid past 90 days', detail: 'Oldest pending commission is 112 days old.' },
          { kind: 'wow_swing', severity: 'warning', title: 'Earnings down 31% week-on-week', detail: 'GBP 720.00 to GBP 496.80.' },
          { kind: 'pending_applications', severity: 'info', title: '3 pending applications', detail: 'Programmes awaiting a decision.' },
          { kind: 'health', severity: 'info', title: 'Awin connected', detail: 'Signed in as Acme Outdoors.' },
        ],
      },
    }, 600),
    openClaudePrompt: (_text) => wait({ ok: true, target: 'desktop' }, 300),
    // Data-locker preview: one configured publisher network, a small earnings
    // headline, and a couple of transaction rows so the table renders in a plain
    // browser. The real data comes from the network reads via main.
    lockerNetworks: () => wait([{ slug: 'awin', name: 'Awin', side: 'publisher', setupMinutes: 5, approval: false, multiBrand: false }], 300),
    lockerEarnings: (_slug, _query, _brand) => wait({
      ok: true,
      data: {
        network: 'awin', totalEarnings: 2840.15, currency: 'GBP',
        byProgramme: [], byStatus: { pending: 420.0, approved: 2420.15, reversed: 0, paid: 0, other: 0, currency: 'GBP' },
        periodFrom: '2026-05-30', periodTo: '2026-06-29',
      },
    }, 500),
    lockerTransactions: (_slug, _query, _brand) => wait({
      ok: true,
      data: [
        { id: 't1', network: 'awin', programmeId: 'p1', programmeName: 'Acme Outdoors', status: 'approved', amount: 120.0, currency: 'GBP', commission: 9.6, dateConverted: '2026-06-18', ageDays: 11, rawNetworkData: {} },
        { id: 't2', network: 'awin', programmeId: 'p2', programmeName: 'Trailhead', status: 'pending', amount: 64.5, currency: 'GBP', commission: 5.16, dateConverted: '2026-06-22', ageDays: 7, rawNetworkData: {} },
      ],
    }, 500),
    lockerExport: (suggestedName, _content) => wait({ ok: true, path: `~/Downloads/${suggestedName || 'export.csv'}` }, 300),
    listSkills: () => wait({
      ok: true,
      skills: [
        { slug: 'affiliate-earnings-report', name: 'affiliate-earnings-report', description: '', trigger: 'show my affiliate earnings' },
        { slug: 'affiliate-network-status', name: 'affiliate-network-status', description: '', trigger: 'check my affiliate networks' },
        { slug: 'audit-affiliate-links', name: 'audit-affiliate-links', description: '', trigger: 'audit my affiliate links' },
        { slug: 'agency-portfolio-rollup', name: 'agency-portfolio-rollup', description: '', trigger: 'show revenue across all clients', side: 'brand' },
      ],
    }, 300),
    installSkills: (slugs) => wait({ ok: true, installed: slugs || [], skipped: [], targetDir: '~/.claude/skills' }, 400),
    listSkillArchetypes: () => wait({
      ok: true,
      archetypes: [
        { id: 'report', label: 'Report', summary: 'Pull data across the chosen networks and present one consolidated summary.' },
        { id: 'health-check', label: 'Health check', summary: 'Verify auth and reachability across the chosen networks.' },
        { id: 'anomaly-scan', label: 'Watch / anomaly scan', summary: 'Compare the current period with the prior one and flag changes.' },
        { id: 'link-audit', label: 'Link audit', summary: 'Check that tracking links still resolve to active programmes.' },
        { id: 'custom', label: 'Custom prompt (advanced)', summary: 'A free-form instruction that still calls only the tools you pick.' },
      ],
    }, 200),
    listNetworkOperations: (slug) => wait({
      ok: true,
      operations: [
        { toolName: `affiliate_${slug}_get_earnings_summary`, description: '' },
        { toolName: `affiliate_${slug}_list_transactions`, description: '' },
        { toolName: `affiliate_${slug}_verify_auth`, description: '' },
      ],
    }, 200),
    composeSkill: (input) => wait({
      ok: true,
      slug: (input.name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      targetPath: `~/.claude/skills/${(input.name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/SKILL.md`,
      content: `---\nname: ${(input.name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-')}\ndescription: |\n  Use this skill for a ${input.archetypeId} across ${(input.networks || []).join(', ')}.\n  Trigger on: "${input.trigger}".\n---\n\n# ${input.name}\n\n## Tools this skill may call\n${(input.operations || []).map((t) => '- `' + t + '`').join('\n')}\n`,
    }, 300),
    saveComposedSkill: (_slug, _content) => wait({ ok: true, path: `~/.claude/skills/${_slug}/SKILL.md` }, 300),
    // Entitlement mock: walks none -> (subscribe) inactive -> (check) active.
    entitlementStatus: () => wait({ ok: true, status: { ...mockEnt } }, 150),
    startCheckout: () => { mockEnt.hasAccount = true; mockEnt.state = 'inactive'; window.open('https://checkout.stripe.com/mock', '_blank'); return wait({ ok: true, url: 'https://checkout.stripe.com/mock' }, 300); },
    refreshEntitlement: () => { mockEnt.state = 'active'; mockEnt.entitled = true; mockEnt.hasAccount = true; return wait({ ok: true, status: { ...mockEnt } }, 400); },
    openPortal: () => { window.open('https://billing.stripe.com/mock', '_blank'); return wait({ ok: true, url: 'https://billing.stripe.com/mock' }, 200); },
    signOutEntitlement: () => { mockEnt.state = 'none'; mockEnt.entitled = false; mockEnt.hasAccount = false; return wait({ ok: true }, 100); },
    connectClaude: () => wait({ ok: true, action: 'added', backupPath: '…/claude_desktop_config.json.bak' }, 500),
    restartClaude: () => wait({ ok: true }),
    openExternal: (url) => { window.open(url, '_blank'); return wait({ ok: true }); },
    quit: () => wait({ ok: true }),
    // Update simulation so the design preview can exercise every button state.
    // Real status is pushed by main; here a "check" walks checking → downloading
    // → ready so the preview shows the click-to-update buttons end to end.
    onUpdateStatus: (cb) => { mockUpdateCb = cb; return () => { mockUpdateCb = null; }; },
    checkForUpdates: () => {
      const emit = (p, ms) => setTimeout(() => mockUpdateCb && mockUpdateCb(p), ms);
      emit({ state: 'checking' }, 0);
      emit({ state: 'downloading', percent: 45 }, 600);
      emit({ state: 'downloading', percent: 100 }, 1100);
      emit({ state: 'ready', version: '0.1.1' }, 1500);
      return wait({ ok: true });
    },
    restartToUpdate: () => wait({ ok: true }),
    openUpdateDownload: () => { window.open('https://github.com/bobberrisford/affiliatemcp/releases/latest', '_blank'); return wait({ ok: true }); },
  };
}
/** Holds the renderer's update-status callback when running on the browser mock. */
let mockUpdateCb = null;
/** Mutable entitlement state for the browser mock (real status comes from IPC). */
const mockEnt = { state: 'none', entitled: false, hasAccount: false };
const api = window.affiliate || mockApi();

/* ---- state ------------------------------------------------------------ */
const state = {
  screen: 'welcome',
  networks: [],
  selected: [],          // slugs
  credIndex: 0,          // index into selected[]
  verified: {},          // slug -> identity
  brandIndex: 0,         // index into brandSideSlugs() — we walk each in turn
  brandsByNet: {},       // slug -> discovered brands[]
  brandSelByNet: {},     // slug -> { id: { on, nick } }
  manualByNet: {},       // slug -> [{ networkBrandId, nick }] for multi-brand nets with no list
  envEntries: {},        // FIELD -> value, accumulated across verified networks
  update: { state: 'idle' }, // latest auto-update status from main (see setupUpdateEvents)
  telemetryEnabled: false,
  cockpit: null,         // latest CockpitSummary (attention flags) from main
  skills: [],            // bundled skill catalogue (SkillSummary[])
  selectedSkills: [],    // bundled slugs chosen in the skills step
  composedSkills: [],    // [{ slug, name, trigger }] built + saved via the composer
};
// Composer wizard state (build-your-own), persisted across its steps.
const composer = { step: 1, archetypeId: null, archetypes: [], networks: [], opsByNet: {}, ops: [], name: '', trigger: '' };
const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Mirrors BRAND_SLUG_RE in src/shared/brands.ts. saveBrands silently skips
// slugs that fail this, so the brands screen validates nicknames against the
// same rule before submitting and treats a short write `count` as a failure.
const BRAND_SLUG_RE = /^[a-z0-9-]+$/;

const FLOW = ['networks', 'credentials', 'brands', 'skills', 'connect'];
function rail(current) {
  const i = FLOW.indexOf(current);
  return `<div class="steps"><span class="stepno">step ${i + 1} / ${FLOW.length}</span>` +
    FLOW.map((_, k) => `<span class="seg ${k <= i ? 'on' : ''}"></span>`).join('') + `</div>`;
}
const wrap = (body, center) => `<div class="screen ${center ? 'center' : ''} fade"><div class="scroll">${body}</div></div>`;

/* ---- screens ---------------------------------------------------------- */
function renderWelcome() {
  app.innerHTML = wrap(`
    <img class="bigmark" src="${MARK}" alt="" />
    <h1 class="welcome-h">chat with your<br>affiliate data.</h1>
    <p class="scr-lead" style="margin-inline:auto">connect the networks you already use, then ask Claude in plain English. it all runs on this machine — your keys never leave it.</p>
    <div class="trust"><span class="chip">● NO HOSTED ACCOUNT</span><span class="chip">● LOCAL-FIRST</span><span class="chip acid">OPEN SOURCE</span></div>
    <button class="btn btn-primary" id="start">get started ▸</button>
    <div class="stepno" style="margin-top:24px">~5 minutes · you’ll need your network logins</div>
  `, true);
  document.getElementById('start').onclick = () => go('networks');
}

// Network-picker view state (transient: query string + active filters). Kept
// here so it survives the per-keystroke re-render of the grid but is reset
// fresh each time the screen mounts. Selections live in state.selected and are
// never touched by filtering — searching a tile away never deselects it.
const picker = { q: '', side: 'all', selectedOnly: false };

// Build the tile markup for one network (shared by initial render + re-filter).
function netTile(n) {
  const on = state.selected.includes(n.slug);
  const sideLabel = n.side === 'brand' ? 'brand' : 'publisher';
  return `<div class="net ${on ? 'sel' : ''}" data-slug="${esc(n.slug)}"><span class="tick">✓</span>
    <div class="nm">${esc(n.name)}</div>
    <div class="mt">~${n.setupMinutes} min · ${esc(sideLabel)}${n.approval ? ' · approval' : ''}</div></div>`;
}

// Apply the current search + filters (AND-combined) to the full network list.
function filteredNetworks() {
  const q = picker.q.trim().toLowerCase();
  return state.networks.filter((n) => {
    if (picker.side !== 'all' && n.side !== picker.side) return false;
    if (picker.selectedOnly && !state.selected.includes(n.slug)) return false;
    if (q && !n.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

async function renderNetworks() {
  if (!state.networks.length) state.networks = await api.listNetworks();
  picker.q = ''; picker.side = 'all'; picker.selectedOnly = false;

  app.innerHTML = `<div class="screen picker fade">
    <div class="picker-head">
      ${rail('networks')}
      <h2 class="scr">which networks do you use?</h2>
      <p class="scr-lead">pick any number. we’ll walk you through each one. publisher or brand side — both work.</p>
      <div class="picker-controls">
        <div class="kv picker-search">
          <span class="pre">find</span>
          <input id="net-q" type="text" placeholder="search ${state.networks.length} networks…" autocomplete="off" spellcheck="false" />
        </div>
        <div class="chips" id="net-filters" role="group" aria-label="filter by side">
          <button class="chip-toggle" data-side="all">all</button>
          <button class="chip-toggle" data-side="publisher">publisher</button>
          <button class="chip-toggle" data-side="brand">brand</button>
          <button class="chip-toggle chip-sel" data-selonly="1">selected only</button>
        </div>
      </div>
    </div>
    <div class="picker-scroll"><div class="grid" id="net-grid"></div></div>
    <div class="picker-bar">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="next">continue ▸</button>
    </div>
  </div>`;

  const grid = document.getElementById('net-grid');
  const next = /** @type {HTMLButtonElement} */(document.getElementById('next'));
  const filters = document.getElementById('net-filters');
  const qInput = /** @type {HTMLInputElement} */(document.getElementById('net-q'));

  // Redraw only the grid (tiles) + footer count + active chip states. The
  // header/search/bar persist, so the search input keeps focus while typing.
  function paint() {
    const list = filteredNetworks();
    if (list.length) {
      grid.classList.remove('empty');
      grid.innerHTML = list.map(netTile).join('');
      grid.querySelectorAll('.net').forEach((tile) => tile.addEventListener('click', () => {
        const slug = tile.getAttribute('data-slug');
        const i = state.selected.indexOf(slug);
        if (i >= 0) state.selected.splice(i, 1); else state.selected.push(slug);
        paint();
      }));
    } else {
      grid.classList.add('empty');
      const reason = picker.q.trim()
        ? `no networks match “${esc(picker.q.trim())}”`
        : 'no networks match these filters';
      grid.innerHTML = `<div class="net-empty"><div class="ne-h">${reason}</div>
        <div class="ne-b">try a different search${picker.side !== 'all' || picker.selectedOnly ? ' or clear the filters' : ''}.</div></div>`;
    }
    // Active filter chips.
    filters.querySelectorAll('.chip-toggle').forEach((c) => {
      const side = c.getAttribute('data-side');
      const on = side ? picker.side === side : picker.selectedOnly;
      c.classList.toggle('on', on);
    });
    next.textContent = state.selected.length ? `${state.selected.length} selected — continue ▸` : 'continue ▸';
    next.disabled = state.selected.length === 0;
  }

  qInput.addEventListener('input', () => { picker.q = qInput.value; paint(); });
  filters.querySelectorAll('.chip-toggle').forEach((c) => c.addEventListener('click', () => {
    const side = c.getAttribute('data-side');
    if (side) picker.side = side; else picker.selectedOnly = !picker.selectedOnly;
    paint();
  }));

  document.getElementById('back').onclick = () => go('welcome');
  next.onclick = () => { if (state.selected.length) { state.credIndex = 0; go('credentials'); } };
  paint();
}

async function renderCredentials() {
  const slug = state.selected[state.credIndex];
  const net = state.networks.find((n) => n.slug === slug);
  const steps = await api.setupSteps(slug);
  const fields = steps.map((s) => `
    <div class="field" data-field="${s.field}">
      <span class="fl">${esc(s.label)}</span>
      <div class="help">${esc(s.description)}
        <div><a class="deeplink" data-url="${esc(s.deepLink || '#')}">↗ open the exact ${esc(net.name)} page</a></div>
      </div>
      <div class="kv"><span class="pre">${esc(s.field.split('_').pop().toLowerCase().slice(0, 6) || 'key')}</span>
        <input type="${s.type === 'password' ? 'password' : 'text'}" placeholder="${esc(s.example || '')}" autocomplete="off" spellcheck="false" /></div>
      <div class="verify-row fstatus" data-fstatus="${s.field}"></div>
    </div>`).join('');
  const last = state.credIndex === state.selected.length - 1;
  app.innerHTML = wrap(`
    ${rail('credentials')}
    <h2 class="scr">connect ${esc(net.name)}</h2>
    <p class="scr-lead">network ${state.credIndex + 1} of ${state.selected.length}. here’s exactly where to find each value — no API knowledge needed.</p>
    ${fields}
    <div class="verify-row" id="vstatus"></div>
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="verify">verify &amp; continue ▸</button>
    </div>
  `);
  app.querySelectorAll('.deeplink').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const url = a.getAttribute('data-url');
    if (!url || url === '#') return;
    // Open via the main process, which allowlists the host — the renderer is
    // not allowed to spawn windows or navigate (see main.js boundary).
    const res = await api.openExternal(url);
    if (res && res.ok === false) {
      a.textContent = `↗ couldn’t open that link (${esc(res.error || 'blocked')})`;
    }
  }));

  // ---- live per-field validation (✓/✗) -----------------------------------
  // On blur of a non-empty field, ask the backend whether the value looks
  // valid and render an inline status using the same status classes the rest
  // of the screen uses. This is additive to "verify & continue" below; it
  // never blocks typing. We guard against overlapping/stale calls per field:
  // a token bumps on each blur so only the newest response renders, and the
  // same value isn't re-validated twice in a row.
  /** @type {Record<string, number>} */
  const fieldTokens = {};
  /** @type {Record<string, string>} */
  const lastValidated = {};
  app.querySelectorAll('.field[data-field]').forEach((f) => {
    const field = f.getAttribute('data-field');
    const input = f.querySelector('input');
    const slot = f.querySelector('[data-fstatus]');
    if (!field || !input || !slot) return;
    input.addEventListener('blur', async () => {
      const value = input.value.trim();
      if (!value) { slot.innerHTML = ''; lastValidated[field] = ''; return; }
      if (lastValidated[field] === value) return; // unchanged — keep prior result
      lastValidated[field] = value;
      const token = (fieldTokens[field] || 0) + 1;
      fieldTokens[field] = token;
      slot.innerHTML = `<span class="status"><span class="dot dot-pending"></span> checking…</span>`;
      let res;
      try {
        res = await api.validateField(slug, field, value);
      } catch {
        res = { ok: false, message: 'could not check this value' };
      }
      if (fieldTokens[field] !== token) return; // a newer blur superseded this
      if (res && res.ok) {
        const msg = res.message ? ` ${esc(res.message)}` : ' looks right';
        slot.innerHTML = `<span class="status"><span class="dot dot-pos"></span>${msg}</span>`;
      } else {
        const msg = (res && (res.message || res.hint)) || 'that doesn’t look right';
        slot.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc(msg)}</span>`;
      }
    });
  });
  // Enter in any credential field submits the screen (verify & continue),
  // matching the obvious keyboard expectation — there's no <form> to do it for us.
  app.querySelectorAll('.field input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('verify').click();
      }
    });
  });
  document.getElementById('back').onclick = () => {
    if (state.credIndex === 0) go('networks');
    else { state.credIndex--; go('credentials'); }
  };
  document.getElementById('verify').onclick = async () => {
    const vs = document.getElementById('vstatus');
    // Collect the entered value for every field on this screen, keyed by the
    // env field name the backend expects (CJ_PERSONAL_ACCESS_TOKEN, …).
    const values = {};
    app.querySelectorAll('.field[data-field]').forEach((f) => {
      const field = f.getAttribute('data-field');
      const input = f.querySelector('input');
      if (field && input) values[field] = input.value.trim();
    });
    vs.innerHTML = `<span class="status"><span class="dot dot-pending"></span> verifying ${esc(net.name)}…</span>`;
    const res = await api.verifyAuth(slug, values);
    if (res && res.ok) {
      state.verified[slug] = res.identity;
      Object.assign(state.envEntries, values); // persist on connect

      vs.innerHTML = `<span class="status"><span class="dot dot-pos"></span> verified as ${esc(res.identity)}</span>`;
      setTimeout(() => {
        if (!last) { state.credIndex++; go('credentials'); }
        else if (anyBrandSide()) { state.brandIndex = 0; go('brands'); }
        else go('skills');
      }, 550);
    } else {
      vs.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc((res && res.reason) || 'could not verify')}</span>`;
    }
  };
}

const anyBrandSide = () => brandSideSlugs().length > 0;
// Selected slugs that are brand/advertiser side, in selection order. The brands
// screen walks these one at a time (state.brandIndex) — every brand-side
// network gets its own discovery + persistence, not just the first.
const brandSideSlugs = () => state.selected.filter((s) => (state.networks.find((n) => n.slug === s) || {}).side === 'brand');

async function renderBrands() {
  const brandSlugs = brandSideSlugs();
  // Defensive: nothing brand-side to do (shouldn't happen via the normal flow).
  if (!brandSlugs.length) { go('skills'); return; }
  if (state.brandIndex < 0) state.brandIndex = 0;
  if (state.brandIndex > brandSlugs.length - 1) state.brandIndex = brandSlugs.length - 1;

  const slug = brandSlugs[state.brandIndex];
  const net = state.networks.find((n) => n.slug === slug) || { name: slug };
  const total = brandSlugs.length;
  const isLastBrand = state.brandIndex === total - 1;

  if (!state.brandsByNet[slug]) {
    const discovered = await api.discoverBrands(slug);
    // discoverBrands throws are turned into { ok:false, error } by the main-process
    // IPC wrapper. Treat a non-array as a discovery failure and surface it with a
    // retry, rather than calling .forEach on it — which would throw a secondary,
    // opaque renderer error and strand the user.
    if (!Array.isArray(discovered)) {
      renderBrandsError(net, slug, (discovered && discovered.error) || 'could not load brands');
      return;
    }
    state.brandsByNet[slug] = discovered;
    const sel = {};
    discovered.forEach((b) => { sel[b.id] = { on: b.status === 'active', nick: b.name.split(' ')[0].toLowerCase() }; });
    state.brandSelByNet[slug] = sel;
  }
  const brands = state.brandsByNet[slug];
  const brandSel = state.brandSelByNet[slug];

  // An empty list means different things. For a single-brand network the
  // credentials are genuinely scoped to one account and there is nothing to
  // pick. For a multi-brand network whose adapter can't enumerate brands
  // (e.g. cj-advertiser, which has no list endpoint) an empty list is NOT
  // "already scoped" — the user must bind brands by hand, so we offer manual
  // (id, nickname) entry instead of letting them continue with nothing.
  const manualMode = !brands.length && !!net.multiBrand;
  if (manualMode && !state.manualByNet[slug]) state.manualByNet[slug] = [{ networkBrandId: '', nick: '' }];
  const manualRows = state.manualByNet[slug] || [];

  const counter = total > 1 ? ` brand network ${state.brandIndex + 1} of ${total} — ${esc(net.name)}.` : '';

  let body;
  if (brands.length) {
    body = brands.map((b) => {
      const sel = brandSel[b.id];
      const dot = b.status === 'active' ? 'dot-pos' : 'dot-pending';
      return `<div class="brow ${sel.on ? '' : 'off'}" data-id="${esc(b.id)}">
          <span class="cb">✓</span><span class="bn">${esc(b.name)}</span>
          <span class="status" style="margin-left:14px"><span class="dot ${dot}"></span> ${esc(b.status)}</span>
          <span class="nick"><input data-nick="${esc(b.id)}" value="${esc(sel.nick)}" placeholder="nickname" /></span>
        </div>`;
    }).join('');
  } else if (manualMode) {
    body = `<div class="help" style="border-left-color:var(--magenta)">${esc(net.name)} can manage more than one brand, but it doesn’t expose a list to pick from automatically. Add each brand’s id from your ${esc(net.name)} dashboard and give it a nickname you’ll use when you ask questions.</div>`
      + manualRows.map((row, i) => `<div class="mrow" data-mrow="${i}">
          <input data-mid="${i}" value="${esc(row.networkBrandId)}" placeholder="brand / account id" />
          <input data-mnick="${i}" value="${esc(row.nick)}" placeholder="nickname (a-z, 0-9, -)" />
          <button class="btn btn-ghost mrow-del" data-mdel="${i}" ${manualRows.length > 1 ? '' : 'disabled'}>remove</button>
        </div>`).join('')
      + `<button class="btn btn-ghost" id="addrow">+ add another brand</button>`;
  } else {
    body = `<div class="help">${esc(net.name)} doesn’t expose a brand list to pick from here — its credentials are already scoped. Continue.</div>`;
  }

  const nextLabel = isLastBrand ? 'save brands — continue ▸' : 'save — next network ▸';
  app.innerHTML = wrap(`
    ${rail('brands')}
    <h2 class="scr">which brands can these keys reach?</h2>
    <p class="scr-lead">your credentials see these advertiser accounts. pick the ones you manage and give each a nickname you’ll use when you ask questions.${counter}</p>
    ${body}
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="next">${nextLabel}</button>
    </div>
  `);

  // A single magenta-ruled note above the actions, reused for validation and
  // persistence problems so a brand never silently fails to save.
  const showBrandNote = (msg) => {
    const existing = app.querySelector('.brand-note');
    if (existing) existing.remove();
    const note = document.createElement('div');
    note.className = 'help brand-note';
    note.style.borderLeftColor = 'var(--magenta)';
    note.textContent = msg;
    app.querySelector('.actions').before(note);
  };

  app.querySelectorAll('.brow').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const id = row.getAttribute('data-id');
    brandSel[id].on = !brandSel[id].on;
    renderBrands();
  }));
  app.querySelectorAll('[data-nick]').forEach((inp) => inp.addEventListener('input', () => {
    brandSel[inp.getAttribute('data-nick')].nick = inp.value;
  }));
  // Manual-entry wiring: update row state on input (no re-render, so focus is
  // kept); only add/remove rows re-render.
  app.querySelectorAll('[data-mid]').forEach((inp) => inp.addEventListener('input', () => {
    manualRows[+inp.getAttribute('data-mid')].networkBrandId = inp.value;
  }));
  app.querySelectorAll('[data-mnick]').forEach((inp) => inp.addEventListener('input', () => {
    manualRows[+inp.getAttribute('data-mnick')].nick = inp.value;
  }));
  app.querySelectorAll('[data-mdel]').forEach((b) => b.addEventListener('click', () => {
    manualRows.splice(+b.getAttribute('data-mdel'), 1);
    renderBrands();
  }));
  const addRow = document.getElementById('addrow');
  if (addRow) addRow.onclick = () => { manualRows.push({ networkBrandId: '', nick: '' }); renderBrands(); };

  document.getElementById('back').onclick = () => {
    if (state.brandIndex > 0) { state.brandIndex--; renderBrands(); }
    else { state.credIndex = state.selected.length - 1; go('credentials'); }
  };
  document.getElementById('next').onclick = async () => {
    const selections = manualMode
      ? manualRows
          .filter((r) => r.networkBrandId.trim() && r.nick.trim())
          .map((r) => ({ networkBrandId: r.networkBrandId.trim(), slug: r.nick.trim() }))
      : brands
          .filter((b) => brandSel[b.id] && brandSel[b.id].on)
          .map((b) => ({ networkBrandId: b.id, slug: brandSel[b.id].nick }));

    // A multi-brand network must end up with at least one binding — advancing
    // with none is the "claims connected but isn't configured" gap we're
    // closing. Discovered-list networks may legitimately have nothing selected.
    if (manualMode && !selections.length) {
      showBrandNote(`add at least one ${net.name} brand (id + nickname), or go back and deselect ${net.name}.`);
      return;
    }

    // Validate nicknames against the same rule the core enforces (lowercase
    // letters, digits, hyphens). saveBrands silently skips invalid slugs, so
    // catching them here keeps the persisted count honest and the message clear.
    const bad = selections.filter((s) => !BRAND_SLUG_RE.test(s.slug));
    if (bad.length) {
      showBrandNote(`fix these nicknames — use lowercase letters, numbers and hyphens only: ${bad.map((s) => s.slug).join(', ')}`);
      return;
    }

    // Reject duplicate nicknames within this network. brands.json keys a binding
    // by (slug, network), so two brands sharing a nickname would have the second
    // overwrite the first — and the count backstop above can't see it (count
    // still equals the submission). The core throws on this too; we catch it
    // here first to give a clearer, pre-write message.
    const slugs = selections.map((s) => s.slug);
    const dupes = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
    if (dupes.length) {
      showBrandNote(`each brand needs a unique nickname — used more than once: ${dupes.join(', ')}`);
      return;
    }

    const res = await api.saveBrands(slug, selections);
    if (res && res.ok === false) {
      showBrandNote(`couldn’t save brands for ${net.name}: ${res.error || 'unknown error'}`);
      return;
    }
    // Backstop: if the core wrote fewer than we sent, some entries were rejected
    // upstream — don't advance and claim success.
    if (res && typeof res.count === 'number' && res.count < selections.length) {
      showBrandNote(`only ${res.count} of ${selections.length} brands saved for ${net.name} — some entries were rejected. check the ids/nicknames and try again.`);
      return;
    }
    if (!isLastBrand) { state.brandIndex++; renderBrands(); }
    else go('skills');
  };
}

// Brand discovery failed (auth, network, or upstream error surfaced as
// { ok:false, error } by the IPC wrapper). Show the reason with a retry that
// re-attempts discovery, plus a back route, instead of stranding the user on a
// half-rendered screen.
function renderBrandsError(net, slug, msg) {
  app.innerHTML = wrap(`
    ${rail('brands')}
    <h2 class="scr">couldn’t load brands</h2>
    <div class="help" style="border-left-color:var(--magenta)">we couldn’t load the brands for ${esc(net.name)}: ${esc(msg)}</div>
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="retry">try again ▸</button>
    </div>
  `);
  document.getElementById('back').onclick = () => {
    if (state.brandIndex > 0) { state.brandIndex--; renderBrands(); }
    else { state.credIndex = state.selected.length - 1; go('credentials'); }
  };
  document.getElementById('retry').onclick = () => {
    delete state.brandsByNet[slug];
    renderBrands();
  };
}

/* ---- skills step (deploy bundled playbooks) --------------------------- */
/* A card picker after the brands step. Skills whose required side isn't
   configured are greyed with a reason, never hidden. Selections install in the
   connect step, before the single Claude restart. Free feature. */
async function renderSkills() {
  const hasPub = state.selected.some(
    (s) => (state.networks.find((n) => n.slug === s) || {}).side === 'publisher',
  );
  const hasBrand = anyBrandSide();
  const lockReason = (s) => {
    if (s.side === 'publisher' && !hasPub) return 'needs a publisher network';
    if ((s.side === 'brand' || s.side === 'agency') && !hasBrand) return 'needs a brand-side network';
    return null;
  };

  if (!state.skills.length) {
    const res = await api.listSkills();
    state.skills = (res && res.skills) || [];
    // First visit: default every available skill on.
    state.selectedSkills = state.skills.filter((s) => !lockReason(s)).map((s) => s.slug);
  }

  app.innerHTML = wrap(`
    ${rail('skills')}
    <h2 class="scr">add skills.</h2>
    <p class="scr-lead">skills are ready-made playbooks — ask Claude in plain English and it knows the steps. pick the ones you’ll use.</p>
    <div class="picker-scroll"><div class="grid" id="skill-grid"></div></div>
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="next"></button>
    </div>
  `);

  const grid = document.getElementById('skill-grid');
  const nextBtn = /** @type {HTMLButtonElement} */ (document.getElementById('next'));

  function paint() {
    const bundledHtml = state.skills
      .map((s) => {
        const reason = lockReason(s);
        const on = state.selectedSkills.includes(s.slug);
        const sub = reason ? esc(reason) : s.trigger ? `try: “${esc(s.trigger)}”` : '';
        return `<div class="net ${on ? 'sel' : ''} ${reason ? 'greyed' : ''}" data-slug="${esc(s.slug)}" ${reason ? 'data-locked="1"' : ''}>
          <div class="nm">${esc(s.name)}</div>
          <div class="mt">${sub}</div>
          <span class="tick">✓</span>
        </div>`;
      })
      .join('');
    // Skills the user composed this session are already written to disk, so
    // they show as saved (ticked, not toggleable).
    const composedHtml = state.composedSkills
      .map(
        (c) => `<div class="net sel" data-composed="1">
          <div class="nm">${esc(c.name)}</div>
          <div class="mt">saved · try: “${esc(c.trigger)}”</div>
          <span class="tick">✓</span>
        </div>`,
      )
      .join('');
    const buildHtml = `<div class="net net-build" id="skill-build">
        <div class="nm">+ build your own</div>
        <div class="mt">compose a skill from your tools</div>
      </div>`;
    grid.innerHTML = composedHtml + bundledHtml + buildHtml;
    grid.querySelectorAll('.net').forEach((tile) => {
      if (tile.getAttribute('data-locked') || tile.getAttribute('data-composed')) return;
      if (tile.id === 'skill-build') {
        tile.addEventListener('click', () => go('composer'));
        return;
      }
      tile.addEventListener('click', () => {
        const slug = tile.getAttribute('data-slug');
        const i = state.selectedSkills.indexOf(slug);
        if (i >= 0) state.selectedSkills.splice(i, 1);
        else state.selectedSkills.push(slug);
        paint();
      });
    });
    const n = state.selectedSkills.length + state.composedSkills.length;
    nextBtn.textContent = n ? `add ${n} skill${n === 1 ? '' : 's'} — continue ▸` : 'skip — just the tools ▸';
  }

  document.getElementById('back').onclick = () => {
    if (anyBrandSide()) { state.brandIndex = brandSideSlugs().length - 1; go('brands'); }
    else { state.credIndex = state.selected.length - 1; go('credentials'); }
  };
  nextBtn.onclick = () => go('connect');
  paint();
}

/* ---- composer (build-your-own skill) ---------------------------------- */
/* A guided wizard: archetype -> networks -> operations -> name+trigger ->
   preview. Every choice is enumerated and real, so the generated SKILL.md only
   ever references tools that exist. Free feature. */
function composerShell(inner) {
  app.innerHTML = wrap(`
    ${rail('skills')}
    <h2 class="scr">build a skill.</h2>
    ${inner}
  `);
}
function composerBar(backLabel, nextLabel, nextDisabled) {
  return `<div class="actions">
    <button class="btn btn-ghost" id="c-back">${backLabel}</button>
    <button class="btn btn-primary" id="c-next" ${nextDisabled ? 'disabled' : ''}>${nextLabel}</button>
  </div>`;
}
function prettyOp(toolName) {
  // affiliate_awin_list_transactions -> list transactions
  return String(toolName).replace(/^affiliate_[a-z0-9-]+_/, '').replace(/_/g, ' ');
}

async function renderComposer() {
  const step = composer.step;

  // Step 1 — archetype
  if (step === 1) {
    if (!composer.archetypes.length) {
      const res = await api.listSkillArchetypes();
      composer.archetypes = (res && res.archetypes) || [];
    }
    const tiles = composer.archetypes
      .map(
        (a) => `<div class="net ${composer.archetypeId === a.id ? 'sel' : ''}" data-arche="${esc(a.id)}">
          <div class="nm">${esc(a.label)}</div>
          <div class="mt">${esc(a.summary)}</div>
          <span class="tick">✓</span>
        </div>`,
      )
      .join('');
    composerShell(`<p class="scr-lead">what should it do? pick a shape — the app writes the playbook from real tools, you never wire anything by hand.</p>
      <div class="picker-scroll"><div class="grid">${tiles}</div></div>
      ${composerBar('back', 'next ▸', !composer.archetypeId)}`);
    document.querySelectorAll('[data-arche]').forEach((t) =>
      t.addEventListener('click', () => { composer.archetypeId = t.getAttribute('data-arche'); renderComposer(); }),
    );
    document.getElementById('c-back').onclick = () => go('skills');
    document.getElementById('c-next').onclick = () => { if (composer.archetypeId) { composer.step = 2; renderComposer(); } };
    return;
  }

  // Step 2 — networks (from the ones the user configured)
  if (step === 2) {
    if (!composer.networks.length) composer.networks = [...state.selected];
    const tiles = state.selected
      .map((slug) => {
        const net = state.networks.find((n) => n.slug === slug) || { name: slug };
        const on = composer.networks.includes(slug);
        return `<div class="net ${on ? 'sel' : ''}" data-net="${esc(slug)}">
          <div class="nm">${esc(net.name)}</div>
          <div class="mt">${esc(slug)}</div>
          <span class="tick">✓</span>
        </div>`;
      })
      .join('');
    composerShell(`<p class="scr-lead">across which networks? we’ll only offer data from the ones you configured.</p>
      <div class="picker-scroll"><div class="grid">${tiles}</div></div>
      ${composerBar('back', 'next ▸', !composer.networks.length)}`);
    document.querySelectorAll('[data-net]').forEach((t) =>
      t.addEventListener('click', () => {
        const slug = t.getAttribute('data-net');
        const i = composer.networks.indexOf(slug);
        if (i >= 0) composer.networks.splice(i, 1); else composer.networks.push(slug);
        renderComposer();
      }),
    );
    document.getElementById('c-back').onclick = () => { composer.step = 1; renderComposer(); };
    document.getElementById('c-next').onclick = () => { if (composer.networks.length) { composer.step = 3; renderComposer(); } };
    return;
  }

  // Step 3 — data operations (real tool names for the chosen networks)
  if (step === 3) {
    for (const slug of composer.networks) {
      if (!composer.opsByNet[slug]) {
        const res = await api.listNetworkOperations(slug);
        composer.opsByNet[slug] = (res && res.operations) || [];
      }
    }
    const allOps = [];
    for (const slug of composer.networks) for (const op of composer.opsByNet[slug]) allOps.push(op.toolName);
    const uniqueOps = [...new Set(allOps)];
    // Default: everything on, first time in.
    if (!composer.ops.length) composer.ops = [...uniqueOps];
    const tiles = uniqueOps
      .map((toolName) => {
        const on = composer.ops.includes(toolName);
        return `<div class="net ${on ? 'sel' : ''}" data-op="${esc(toolName)}">
          <div class="nm">${esc(prettyOp(toolName))}</div>
          <div class="mt">${esc(toolName)}</div>
          <span class="tick">✓</span>
        </div>`;
      })
      .join('');
    composerShell(`<p class="scr-lead">using which data? the skill can only call the tools you tick here — it never invents one.</p>
      <div class="picker-scroll"><div class="grid">${tiles}</div></div>
      ${composerBar('back', 'next ▸', false)}`);
    document.querySelectorAll('[data-op]').forEach((t) =>
      t.addEventListener('click', () => {
        const op = t.getAttribute('data-op');
        const i = composer.ops.indexOf(op);
        if (i >= 0) composer.ops.splice(i, 1); else composer.ops.push(op);
        renderComposer();
      }),
    );
    document.getElementById('c-back').onclick = () => { composer.step = 2; renderComposer(); };
    document.getElementById('c-next').onclick = () => { composer.step = 4; renderComposer(); };
    return;
  }

  // Step 4 — name + trigger
  if (step === 4) {
    composerShell(`<p class="scr-lead">name it, and give it a trigger phrase — that’s what you say to Claude to run it.</p>
      <div class="kv"><span class="pre">name</span><input id="c-name" type="text" placeholder="my awin report" value="${esc(composer.name)}" autocomplete="off" /></div>
      <div class="kv" style="margin-top:12px"><span class="pre">say</span><input id="c-trigger" type="text" placeholder="run my awin report" value="${esc(composer.trigger)}" autocomplete="off" /></div>
      <div class="verify-row" id="c-err"></div>
      ${composerBar('back', 'preview ▸', false)}`);
    const nameEl = /** @type {HTMLInputElement} */ (document.getElementById('c-name'));
    const trigEl = /** @type {HTMLInputElement} */ (document.getElementById('c-trigger'));
    nameEl.addEventListener('input', () => { composer.name = nameEl.value; });
    trigEl.addEventListener('input', () => { composer.trigger = trigEl.value; });
    document.getElementById('c-back').onclick = () => { composer.step = 3; renderComposer(); };
    document.getElementById('c-next').onclick = () => {
      composer.name = nameEl.value.trim();
      composer.trigger = trigEl.value.trim();
      const err = document.getElementById('c-err');
      if (!composer.name || !composer.trigger) {
        err.innerHTML = `<span class="status"><span class="dot dot-neg"></span> give it a name and a trigger phrase</span>`;
        return;
      }
      composer.step = 5; renderComposer();
    };
    return;
  }

  // Step 5 — preview + save
  const res = await api.composeSkill({
    archetypeId: composer.archetypeId,
    networks: composer.networks,
    operations: composer.ops,
    name: composer.name,
    trigger: composer.trigger,
  });
  if (!res || res.ok === false) {
    composerShell(`<div class="verify-row"><span class="status"><span class="dot dot-neg"></span> ${esc((res && res.error) || 'could not build the skill')}</span></div>
      ${composerBar('back', 'save skill ▸', true)}`);
    document.getElementById('c-back').onclick = () => { composer.step = 4; renderComposer(); };
    return;
  }
  composerShell(`<p class="scr-lead">this is the playbook. it writes to <code>${esc(res.targetPath)}</code>.</p>
    <pre class="preview">${esc(res.content)}</pre>
    <div class="verify-row" id="c-err"></div>
    ${composerBar('back to tweak', 'save skill ▸', false)}`);
  document.getElementById('c-back').onclick = () => { composer.step = 4; renderComposer(); };
  document.getElementById('c-next').onclick = async () => {
    const err = document.getElementById('c-err');
    const saved = await api.saveComposedSkill(res.slug, res.content);
    if (!saved || saved.ok === false) {
      err.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc((saved && saved.error) || 'could not save')}</span>`;
      return;
    }
    state.composedSkills.push({ slug: res.slug, name: composer.name, trigger: composer.trigger });
    // Reset the wizard for a possible next build.
    composer.step = 1; composer.archetypeId = null; composer.networks = []; composer.opsByNet = {}; composer.ops = []; composer.name = ''; composer.trigger = '';
    go('skills');
  };
}

/* ---- account / premium subscription ----------------------------------- */
/* Shows subscription status and the subscribe / manage / sign-out actions.
   Free-tier users can ignore this entirely — the free skills and composer work
   without it. Gating of the premium shelf (PR-5) reads entitlementStatus. */
async function renderAccount() {
  let status = { state: 'none', entitled: false, hasAccount: false };
  if (api.entitlementStatus) {
    const res = await api.entitlementStatus();
    if (res && res.status) status = res.status;
  }
  const active = status.state === 'active';

  const body = active
    ? `<div class="detect"><span class="ico">✓</span>
        <span class="meta"><div class="a">premium active</div><div class="b">your premium skill packs are unlocked</div></span>
        <span class="status"><span class="dot dot-pos"></span> subscribed</span></div>
       <div class="actions">
         <button class="btn btn-ghost" id="a-back">back</button>
         <span style="display:flex;gap:10px">
           <button class="btn btn-ghost" id="a-signout">sign out</button>
           <button class="btn btn-primary" id="a-manage">manage subscription ▸</button>
         </span>
       </div>`
    : `<div class="q"><span class="p">&gt;</span> ${status.hasAccount ? 'your subscription isn’t active right now.' : 'unlock a growing library of maintained premium skill packs.'}</div>
       <p class="scr-lead">£20/month, cancel any time. the free skills and the composer stay free forever.</p>
       <div class="verify-row" id="a-status"></div>
       <div class="actions">
         <button class="btn btn-ghost" id="a-back">back</button>
         <span style="display:flex;gap:10px">
           ${status.hasAccount ? '<button class="btn btn-ghost" id="a-refresh">I’ve paid — check now</button>' : ''}
           <button class="btn btn-primary" id="a-sub">subscribe — £20/mo ▸</button>
         </span>
       </div>`;

  app.innerHTML = wrap(`
    ${rail('skills')}
    <h2 class="scr">premium.</h2>
    ${body}
  `);

  const back = document.getElementById('a-back');
  if (back) back.onclick = () => go('skills');
  const sub = document.getElementById('a-sub');
  if (sub) sub.onclick = async () => {
    const s = document.getElementById('a-status');
    s.innerHTML = `<span class="status"><span class="dot dot-pending"></span> opening checkout…</span>`;
    const res = await api.startCheckout?.();
    if (!res || res.ok === false) {
      s.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc((res && res.error) || 'could not start checkout')}</span>`;
      return;
    }
    renderAccount(); // account key now stored → reveals "I've paid — check now"
  };
  const refresh = document.getElementById('a-refresh');
  if (refresh) refresh.onclick = async () => {
    const s = document.getElementById('a-status');
    s.innerHTML = `<span class="status"><span class="dot dot-pending"></span> checking…</span>`;
    await api.refreshEntitlement?.();
    renderAccount();
  };
  const manage = document.getElementById('a-manage');
  if (manage) manage.onclick = () => api.openPortal?.();
  const signout = document.getElementById('a-signout');
  if (signout) signout.onclick = async () => { await api.signOutEntitlement?.(); renderAccount(); };
}

async function renderConnect() {
  const det = await api.detectClients();
  const telemetry = await api.getTelemetryConsent();
  state.telemetryEnabled = telemetry && telemetry.consent === 'enabled';
  const present = det.desktop === 'present';
  app.innerHTML = wrap(`
    ${rail('connect')}
    <h2 class="scr">hook it up to Claude.</h2>
    <p class="scr-lead">${present ? 'we found Claude Desktop on this Mac. we’ll add affiliate-mcp to its tools and back up your existing config first.' : 'Claude Desktop isn’t installed yet. install it, then come back.'}</p>
    <div class="detect">
      <span class="ico">&gt;_</span>
      <span class="meta"><div class="a">Claude Desktop</div><div class="b">${esc(present ? det.desktopConfigPath : 'not detected')}</div></span>
      <span class="status"><span class="dot ${present ? 'dot-pos' : 'dot-idle'}"></span> ${present ? 'ready' : 'absent'}</span>
    </div>
    <div class="help" style="border-left-color:var(--magenta);margin-top:16px">Claude only loads new tools on restart — one click does it, then this app closes.</div>
    <label class="help" style="display:block;margin-top:16px">
      <input id="telemetry-consent" type="checkbox" ${state.telemetryEnabled ? 'checked' : ''} />
      Share anonymous usage telemetry. Once daily this sends package version, launch surface, and counts by network, operation, and coarse outcome. Never credentials, affiliate data, prompts, arguments, results, or error text.
    </label>
    <div class="verify-row" id="cstatus"></div>
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="go" ${present ? '' : 'disabled'}>connect &amp; restart Claude ▸</button>
    </div>
  `);
  document.getElementById('back').onclick = () => go('skills');
  const goBtn = document.getElementById('go');
  if (goBtn) goBtn.onclick = async () => {
    const cs = document.getElementById('cstatus');
    // Each step must succeed before the next runs, and ALL must succeed before
    // we show "all set". A failure stops here with an actionable message rather
    // than marching on to the done screen. Steps return either a structured
    // failure ({ ok:false, error }) or, for connect, a desktop edit result.
    const fail = (msg) => {
      cs.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc(msg)}</span>`;
      goBtn.disabled = false;
      goBtn.textContent = 'try again ▸';
    };
    const failed = (res) => res && res.ok === false;

    goBtn.disabled = true;
    cs.innerHTML = `<span class="status"><span class="dot dot-pending"></span> writing credentials…</span>`;
    const saved = await api.saveEnv(state.envEntries);
    if (failed(saved)) return fail(`couldn’t save credentials: ${saved.error || 'unknown error'}`);

    const telemetryConsent = document.getElementById('telemetry-consent').checked;
    const telemetrySaved = await api.setTelemetryConsent(telemetryConsent);
    if (failed(telemetrySaved)) return fail(`couldn’t save telemetry preference: ${telemetrySaved.error || 'unknown error'}`);

    cs.innerHTML = `<span class="status"><span class="dot dot-pending"></span> writing Claude config…</span>`;
    const connected = await api.connectClaude();
    if (failed(connected)) return fail(`couldn’t update Claude’s config: ${connected.error || 'unknown error'}`);

    // Deploy selected skills before the single restart, so Claude loads tools
    // and skills together (a local file copy — no network).
    if (state.selectedSkills.length && api.installSkills) {
      cs.innerHTML = `<span class="status"><span class="dot dot-pending"></span> installing skills…</span>`;
      const skillsRes = await api.installSkills(state.selectedSkills);
      if (failed(skillsRes)) return fail(`couldn’t install skills: ${skillsRes.error || 'unknown error'}`);
    }

    cs.innerHTML = `<span class="status"><span class="dot dot-pending"></span> restarting Claude…</span>`;
    const restarted = await api.restartClaude();
    if (failed(restarted)) return fail(`couldn’t restart Claude: ${restarted.error || 'restart it yourself to load the tools'}`);

    cs.innerHTML = `<span class="status"><span class="dot dot-pos"></span> done</span>`;
    // Land on the daily cockpit rather than a dead-end success screen: this is
    // the dashboard the user comes back to. Force a fresh read.
    state.cockpit = null;
    go('cockpit');
  };
}

function renderDone() {
  const count = state.selected.length;
  app.innerHTML = wrap(`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
      <span class="stamp" style="color:var(--blue)">ALL SET</span>
      <span class="status"><span class="dot dot-pos"></span> ${count} network${count === 1 ? '' : 's'} connected</span>
    </div>
    <h2 class="scr">ask Claude anything.</h2>
    <p class="scr-lead">switch to Claude and try one of these.</p>
    <div class="q"><span class="p">&gt;</span> what did I earn across all networks last month?</div>
    <div class="q"><span class="p">&gt;</span> any programmes with transactions pending past 90 days?</div>
    <div class="q"><span class="p">&gt;</span> how is acme performing this quarter vs last?</div>
    <div class="actions">
      <button class="btn btn-ghost" id="again">add another network</button>
      <button class="btn btn-primary" id="quit">done — close</button>
    </div>
  `);
  document.getElementById('again').onclick = () => go('networks');
  document.getElementById('quit').onclick = () => api.quit();
}

/* ---- cockpit (the daily dashboard) ------------------------------------ */
/* The screen people come back to. It shows live "attention flags" computed on
   this machine (no model, no tokens) and a grid of one-click buttons that
   deep-link into Claude with a pre-written prompt — that's where the reasoning
   and any "doing" happen, on the user's own Claude. */

// Each button hands Claude a short instruction; the connector pulls the data.
// Text is kept short on purpose (the deep-link q param is length-capped).
const COCKPIT_ACTIONS = [
  { label: 'earnings report', prompt: 'Show me my affiliate earnings for last month.' },
  { label: 'chase unpaid', prompt: 'Which commissions haven’t been paid in more than 90 days? Draft the chase emails.' },
  { label: 'find programmes to join', prompt: 'Build my Awin application shortlist.' },
  { label: 'apply to programmes', prompt: 'Apply to my Awin shortlist.' },
  { label: 'check my setup', prompt: 'Check my affiliate networks are working.' },
];

// Contextual "do something about it" action for a flag, where one fits.
function flagAction(flag) {
  switch (flag.kind) {
    case 'unpaid_over_threshold':
      return { label: 'chase these', prompt: 'Which commissions haven’t been paid in more than 90 days? Draft the chase emails.' };
    case 'pending_applications':
      return { label: 'review', prompt: 'Build my Awin application shortlist.' };
    case 'wow_swing':
      return { label: 'investigate', prompt: 'Why did my affiliate earnings change week-on-week? Break it down by programme.' };
    default:
      return null;
  }
}

function money(value, currency) {
  if (typeof value !== 'number') return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(value);
  } catch {
    return `${currency || ''} ${value.toFixed(2)}`;
  }
}

const dotForSeverity = (sev) => (sev === 'error' ? 'dot-neg' : sev === 'warning' ? 'dot-pending' : 'dot-pos');

async function renderCockpit() {
  if (!state.cockpit) {
    app.innerHTML = wrap(`
      <h2 class="scr">loading your cockpit…</h2>
      <p class="scr-lead">reading your latest numbers. this runs on this machine — nothing leaves it.</p>
    `, true);
    let res;
    try { res = await api.cockpitSummary(); } catch (e) { res = { ok: false, error: String(e) }; }
    state.cockpit = res && res.ok && res.summary
      ? res.summary
      : { network: 'awin', configured: false, flags: [{ kind: 'health', severity: 'error', title: 'couldn’t load your data', detail: (res && res.error) || 'unknown error' }] };
  }
  const c = state.cockpit;

  const headline = c.headline ? `
    <div class="ck-headline">
      <div class="ck-total">${esc(money(c.headline.totalEarnings, c.headline.currency))}</div>
      <div class="ck-sub">
        last 30 days
        <span class="status"><span class="dot dot-pending"></span> ${esc(money(c.headline.byStatus.pending, c.headline.byStatus.currency))} pending</span>
        <span class="status"><span class="dot dot-pos"></span> ${esc(money(c.headline.byStatus.approved, c.headline.byStatus.currency))} approved</span>
      </div>
    </div>` : '';

  const flagRows = (c.flags || []).map((f) => {
    const action = flagAction(f);
    const btn = action ? `<button class="btn btn-ghost ck-flag-act" data-prompt="${esc(action.prompt)}">${esc(action.label)} ▸</button>` : '';
    return `<div class="ck-flag">
      <span class="status"><span class="dot ${dotForSeverity(f.severity)}"></span></span>
      <div class="ck-flag-body">
        <div class="ck-flag-title">${esc(f.title)}</div>
        ${f.detail ? `<div class="ck-flag-detail">${esc(f.detail)}</div>` : ''}
      </div>${btn}
    </div>`;
  }).join('');

  const actionGrid = COCKPIT_ACTIONS
    .map((a) => `<button class="btn btn-primary ck-action" data-prompt="${esc(a.prompt)}">${esc(a.label)} ▸</button>`)
    .join('');

  app.innerHTML = `<div class="screen fade"><div class="scroll">
    <div class="ck-top">
      <h2 class="scr">your affiliate cockpit</h2>
      <button class="btn btn-ghost" id="ck-refresh">refresh</button>
    </div>
    ${c.configured ? '' : `<div class="help" style="border-left-color:var(--magenta)">connect a network in setup to see your numbers here.</div>`}
    ${headline}
    <div class="ck-flags">${flagRows || '<div class="help">nothing needs your attention right now.</div>'}</div>
    <div class="ck-divider">do something about it · opens in claude</div>
    <div class="ck-actions">${actionGrid}</div>
    <div class="ck-foot">
      <button class="btn btn-primary" id="ck-data">browse your data ▸</button>
      <button class="btn btn-ghost" id="ck-add">add another network</button>
    </div>
  </div></div>`;

  // Deep-link buttons: hand the prompt to main, which opens Claude pre-filled.
  app.querySelectorAll('[data-prompt]').forEach((b) => b.addEventListener('click', async () => {
    const prompt = b.getAttribute('data-prompt');
    const original = b.textContent;
    b.textContent = 'opening claude…';
    let res;
    try { res = await api.openClaudePrompt(prompt); } catch (e) { res = { ok: false, error: String(e) }; }
    if (res && res.ok === false) {
      b.textContent = `couldn’t open claude (${esc(res.error || 'blocked')})`;
    } else {
      b.textContent = 'opened in claude ✓';
      setTimeout(() => { b.textContent = original; }, 1600);
    }
  }));
  document.getElementById('ck-refresh').onclick = () => { state.cockpit = null; renderCockpit(); };
  document.getElementById('ck-data').onclick = () => go('locker');
  document.getElementById('ck-add').onclick = () => { state.selected = []; state.credIndex = 0; go('networks'); };
}

/* ---- data locker (read-only: pull + view) ----------------------------- */
/* Pulls performance data through the facade and renders it as plain rows — the
   same columns a CSV would carry. The app surfaces the data; the analysis stays
   in Claude (the cockpit's deep-link buttons). No charts, no scoring here —
   that's the anti-dashboard line from
   docs/decisions/2026-06-29-desktop-data-export.md. Publisher-side only for now;
   advertiser pulls need brand selection (a follow-up; the facade supports it).
   Export (CSV/JSON) lands in the next slice. */

const ymd = (d) => d.toISOString().slice(0, 10);

const lockerState = {
  nets: null, // configured publisher networks (lazy-loaded once)
  slug: null, // selected network
  from: '',
  to: '',
  loading: false,
  result: null, // { earnings, txns } on a successful pull
  error: null, // honest failure line (envelope or string)
};

// A failure may be a NetworkErrorEnvelope (from the facade) or a plain string
// (from the IPC wrapper). Render the most useful honest line either way; never
// swallow it into an empty table.
function errText(error) {
  if (!error) return 'could not pull your data.';
  if (typeof error === 'string') return error;
  const where = error.network && error.operation ? `${esc(error.network)} ${esc(error.operation)}: ` : '';
  return `${where}${esc(error.message || 'request failed')}`;
}

// Quote a CSV field only when it contains a comma, quote, or newline; double
// embedded quotes. RFC-4180-ish, dependency-free.
function csvField(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Flat CSV of the canonical transaction columns (rawNetworkData is omitted; the
// JSON export carries the full objects for anyone who needs it).
function transactionsToCsv(rows) {
  const cols = ['id', 'network', 'programmeId', 'programmeName', 'status', 'amount', 'commission', 'currency', 'dateConverted', 'ageDays'];
  const lines = rows.map((t) => cols.map((c) => csvField(t[c])).join(','));
  return [cols.join(','), ...lines].join('\r\n');
}

// JSON export: the full pull (network, window, earnings, and complete
// transaction objects including rawNetworkData).
function lockerExportJson() {
  const r = lockerState.result || {};
  return JSON.stringify({
    network: lockerState.slug,
    periodFrom: lockerState.from,
    periodTo: lockerState.to,
    earnings: r.earnings || null,
    transactions: r.txns || [],
  }, null, 2);
}

async function renderLocker() {
  if (!lockerState.nets) {
    app.innerHTML = wrap('<h2 class="scr">your data</h2><p class="scr-lead">finding your connected networks…</p>', true);
    let nets;
    try { nets = await api.lockerNetworks?.(); } catch { nets = null; }
    lockerState.nets = (Array.isArray(nets) ? nets : []).filter((n) => n.side === 'publisher');
    if (!lockerState.slug && lockerState.nets.length) lockerState.slug = lockerState.nets[0].slug;
    if (!lockerState.to) {
      const now = new Date();
      lockerState.to = ymd(now);
      lockerState.from = ymd(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    }
  }

  if (!lockerState.nets.length) {
    app.innerHTML = `<div class="screen fade"><div class="scroll">
      <div class="ck-top"><h2 class="scr">your data</h2><button class="btn btn-ghost" id="lk-back">back</button></div>
      <div class="help" style="border-left-color:var(--magenta)">no connected networks yet. add one in setup, then pull your data here.</div>
      <div class="actions"><button class="btn btn-primary" id="lk-setup">connect a network ▸</button></div>
    </div></div>`;
    document.getElementById('lk-back').onclick = () => go('cockpit');
    document.getElementById('lk-setup').onclick = () => { state.selected = []; state.credIndex = 0; go('networks'); };
    return;
  }

  const chips = lockerState.nets.map((n) =>
    `<button class="btn ${n.slug === lockerState.slug ? 'btn-primary' : 'btn-ghost'} lk-net" data-slug="${esc(n.slug)}">${esc(n.name)}</button>`,
  ).join('');

  let headline = '';
  if (lockerState.result && lockerState.result.earnings) {
    const e = lockerState.result.earnings;
    headline = `<div class="ck-headline">
      <div class="ck-total">${esc(money(e.totalEarnings, e.currency))}</div>
      <div class="ck-sub">${esc(lockerState.from)} → ${esc(lockerState.to)}
        <span class="status"><span class="dot dot-pending"></span> ${esc(money(e.byStatus.pending, e.byStatus.currency))} pending</span>
        <span class="status"><span class="dot dot-pos"></span> ${esc(money(e.byStatus.approved, e.byStatus.currency))} approved</span>
      </div></div>`;
  }

  let tableBlock;
  if (lockerState.error) {
    tableBlock = `<div class="help" style="border-left-color:var(--magenta)">${errText(lockerState.error)}</div>`;
  } else if (lockerState.result && lockerState.result.txns) {
    const rows = lockerState.result.txns;
    if (!rows.length) {
      tableBlock = '<div class="help">no transactions in this window.</div>';
    } else {
      const body = rows.map((t) => {
        const dot = t.status === 'reversed' ? 'dot-neg' : t.status === 'pending' ? 'dot-pending' : 'dot-pos';
        return `<tr>
          <td>${esc((t.dateConverted || '').slice(0, 10))}</td>
          <td>${esc(t.programmeName || t.programmeId || '')}</td>
          <td><span class="status"><span class="dot ${dot}"></span> ${esc(t.status)}</span></td>
          <td class="num">${esc(money(t.amount, t.currency))}</td>
          <td class="num">${esc(money(t.commission, t.currency))}</td>
        </tr>`;
      }).join('');
      tableBlock = `<div class="lk-count">${rows.length} transaction${rows.length === 1 ? '' : 's'}</div>
        <table class="lk-table"><thead><tr><th>date</th><th>programme</th><th>status</th><th class="num">amount</th><th class="num">commission</th></tr></thead><tbody>${body}</tbody></table>`;
    }
  } else {
    tableBlock = '<div class="help">pick a network and a date range, then pull your data. it stays on this machine.</div>';
  }

  // Export + handoff appear only once there are rows to act on. Export writes a
  // local file; "continue in Claude" hands the analysis to Claude — the app
  // surfaces and exports, Claude interprets.
  const hasRows = !!(lockerState.result && lockerState.result.txns && lockerState.result.txns.length);
  const exportBlock = hasRows ? `<div class="lk-actions">
      <button class="btn btn-ghost lk-exp" data-fmt="csv">export CSV</button>
      <button class="btn btn-ghost lk-exp" data-fmt="json">export JSON</button>
      <button class="btn btn-primary" id="lk-claude">continue in Claude ▸</button>
    </div>
    <div class="lk-status" id="lk-status"></div>` : '';

  app.innerHTML = `<div class="screen fade"><div class="scroll">
    <div class="ck-top"><h2 class="scr">your data</h2><button class="btn btn-ghost" id="lk-back">back</button></div>
    <p class="scr-lead">pull your performance data and view it here. the app shows and exports it — ask Claude to interpret it.</p>
    <div class="lk-nets">${chips}</div>
    <div class="lk-range">
      <label>from <input type="date" id="lk-from" value="${esc(lockerState.from)}" /></label>
      <label>to <input type="date" id="lk-to" value="${esc(lockerState.to)}" /></label>
      <button class="btn btn-primary" id="lk-pull"${lockerState.loading ? ' disabled' : ''}>${lockerState.loading ? 'pulling…' : 'pull ▸'}</button>
    </div>
    ${headline}
    ${exportBlock}
    ${tableBlock}
  </div></div>`;

  document.getElementById('lk-back').onclick = () => go('cockpit');
  app.querySelectorAll('.lk-net').forEach((b) => { b.onclick = () => {
    lockerState.slug = b.getAttribute('data-slug');
    lockerState.result = null; lockerState.error = null;
    renderLocker();
  }; });
  const fromEl = document.getElementById('lk-from');
  const toEl = document.getElementById('lk-to');
  fromEl.onchange = () => { lockerState.from = fromEl.value; };
  toEl.onchange = () => { lockerState.to = toEl.value; };
  document.getElementById('lk-pull').onclick = async () => {
    lockerState.loading = true; lockerState.error = null; renderLocker();
    const query = { from: lockerState.from, to: lockerState.to };
    let earnings = null; let txns = []; let error = null;
    try {
      const [eRes, tRes] = await Promise.all([
        api.lockerEarnings?.(lockerState.slug, query),
        api.lockerTransactions?.(lockerState.slug, query),
      ]);
      // Surface the first real failure honestly; transactions are the table, so
      // prefer their error if both fail.
      if (tRes && tRes.ok === false) error = tRes.error;
      else if (eRes && eRes.ok === false) error = eRes.error;
      else { earnings = eRes && eRes.ok ? eRes.data : null; txns = tRes && tRes.ok ? tRes.data : []; }
    } catch (e) {
      error = String(e);
    }
    lockerState.loading = false;
    lockerState.result = error ? null : { earnings, txns };
    lockerState.error = error;
    renderLocker();
  };

  // Export the pulled rows to a local file, and the Claude handoff. Both are
  // present only when a successful pull produced rows.
  app.querySelectorAll('.lk-exp').forEach((b) => { b.onclick = async () => {
    const rows = (lockerState.result && lockerState.result.txns) || [];
    if (!rows.length) return;
    const fmt = b.getAttribute('data-fmt');
    const name = `${lockerState.slug}-transactions-${lockerState.from}_${lockerState.to}.${fmt}`;
    const content = fmt === 'json' ? lockerExportJson() : transactionsToCsv(rows);
    const status = document.getElementById('lk-status');
    if (status) status.textContent = 'saving…';
    let res;
    try { res = await api.lockerExport?.(name, content); } catch (e) { res = { ok: false, error: String(e) }; }
    if (!status) return;
    if (res && res.ok) status.innerHTML = `<span class="status"><span class="dot dot-pos"></span> saved to ${esc(res.path)}</span>`;
    else if (res && res.canceled) status.textContent = 'export cancelled.';
    else status.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc((res && res.error) || 'export failed')}</span>`;
  }; });

  const claudeBtn = document.getElementById('lk-claude');
  if (claudeBtn) claudeBtn.onclick = async () => {
    const promptText = `Analyse my ${lockerState.slug} affiliate transactions from ${lockerState.from} to ${lockerState.to}: spot trends, anomalies, and any commissions worth chasing.`;
    const original = claudeBtn.textContent;
    claudeBtn.textContent = 'opening claude…';
    let res;
    try { res = await api.openClaudePrompt?.(promptText); } catch (e) { res = { ok: false, error: String(e) }; }
    if (res && res.ok === false) {
      claudeBtn.textContent = `couldn’t open claude (${(res.error) || 'blocked'})`;
    } else {
      claudeBtn.textContent = 'opened in claude ✓';
      setTimeout(() => { claudeBtn.textContent = original; }, 1600);
    }
  };
}

/* ---- router ----------------------------------------------------------- */
const SCREENS = {
  welcome: renderWelcome, networks: renderNetworks,
  credentials: renderCredentials, brands: renderBrands, skills: renderSkills, composer: renderComposer, account: renderAccount, connect: renderConnect,
  done: renderDone, cockpit: renderCockpit, locker: renderLocker,
};
function go(name) { state.screen = name; (SCREENS[name] || renderWelcome)(); }

/* ---- auto-update: persistent "relaunch to update" pill ---------------- */
/* The main process pushes status over `onUpdateStatus`; the user can also
   re-check from the titlebar (`#tb-check`). We render the latest state.update
   into the window-level `#update-pill` (bottom-left), so a download that
   finishes mid-flow surfaces "relaunch to update" on whatever screen is
   mounted — the pill outlives the per-screen re-renders.

   Quiet by contract: informational states (checking / downloading) are low-key,
   "up to date" confirms then fades, and the pill only turns loud (primary /
   alert action) when there's something to click. Nothing here ever blocks the
   app; ignoring the pill still installs the update on quit.
   States: idle | checking | downloading | ready | manual | current | unavailable. */

// The brand mark as an inline tile: riso-blue for the healthy path, hot pink to
// signal the degraded manual-download fallback.
const MARK_TILE = '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="120" height="120" rx="14" fill="#2B2BFF"/><polyline points="34,38 58,60 34,82" fill="none" stroke="#fff" stroke-width="13" stroke-linecap="square" stroke-linejoin="miter"/><rect x="66" y="68" width="24" height="14" fill="#fff"/></svg>';
const MARK_TILE_ALERT = '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="120" height="120" rx="14" fill="#FF2E88"/><polyline points="34,38 58,60 34,82" fill="none" stroke="#fff" stroke-width="13" stroke-linecap="square" stroke-linejoin="miter"/><rect x="66" y="68" width="24" height="14" fill="#fff"/></svg>';

// Handle for the auto-fade of transient states (current / unavailable).
let updateFadeTimer = null;

// Describe the pill for the given update state, or null to hide it entirely.
function updatePillSpec(u) {
  switch (u.state) {
    case 'checking':
      return { tone: 'quiet', tile: 'spin', title: 'checking for updates' };
    case 'downloading': {
      const pct = typeof u.percent === 'number' && u.percent > 0 ? u.percent : null;
      const meta = [u.version ? `v${u.version}` : '', pct != null ? `${pct}%` : ''].filter(Boolean).join(' · ');
      return { tone: 'quiet', tile: 'spin', title: 'downloading update', meta, progress: pct };
    }
    case 'ready':
      return { tone: 'ready', tile: 'mark', title: 'relaunch to update',
        meta: u.version ? `v${u.version} ready` : 'ready',
        action: { id: 'u-restart', glyph: '→', label: 'restart & install' } };
    case 'manual':
      return { tone: 'alert', tile: 'alert', title: 'new version available',
        meta: `${u.version ? `v${u.version} · ` : ''}download`,
        action: { id: 'u-dl', glyph: '↗', label: 'open download page' } };
    case 'current':
      return { tone: 'ok', tile: 'mark', title: 'up to date', dot: 'dot-pos',
        meta: u.version ? `v${u.version}` : '', fade: 4000 };
    case 'unavailable':
      return { tone: 'neg', tile: 'mark', title: 'couldn’t check for updates', dot: 'dot-neg',
        action: { id: 'u-check', glyph: '↻', label: 'try again' }, fade: 8000 };
    default: // idle: nothing to show yet (the launch check runs automatically).
      return null;
  }
}

// Render state.update into the window-level #update-pill and wire its action.
// Safe to call from anywhere; the pill lives outside the screen router.
function paintUpdatePill() {
  const pill = document.getElementById('update-pill');
  if (!pill) return;
  if (updateFadeTimer) { clearTimeout(updateFadeTimer); updateFadeTimer = null; }

  const u = state.update || { state: 'idle' };
  const spec = updatePillSpec(u);
  if (!spec) { pill.hidden = true; pill.innerHTML = ''; return; }

  const tile = spec.tile === 'spin' ? '<span class="pill-spin"></span>'
    : spec.tile === 'alert' ? MARK_TILE_ALERT
    : MARK_TILE;
  const dot = spec.dot ? `<span class="dot ${spec.dot}"></span>` : '';
  const meta = (dot || spec.meta) ? `<div class="pill-meta">${dot}${spec.meta ? esc(spec.meta) : ''}</div>` : '';
  const action = spec.action
    ? `<button class="pill-go${spec.tone === 'alert' ? ' alert' : ''}" id="${spec.action.id}" title="${esc(spec.action.label)}" aria-label="${esc(spec.action.label)}">${spec.action.glyph}</button>`
    : '';
  const bar = typeof spec.progress === 'number' ? `<span class="pill-bar" style="width:${spec.progress}%"></span>` : '';

  pill.className = `update-pill tone-${spec.tone}`;
  pill.hidden = false;
  pill.innerHTML = `<span class="pill-tile">${tile}</span><div class="pill-txt"><div class="pill-title">${esc(spec.title)}</div>${meta}</div>${action}${bar}`;

  const restart = document.getElementById('u-restart');
  if (restart && api.restartToUpdate) restart.onclick = () => api.restartToUpdate();
  const dl = document.getElementById('u-dl');
  if (dl && api.openUpdateDownload) dl.onclick = () => api.openUpdateDownload();
  const check = document.getElementById('u-check');
  if (check) check.onclick = onCheckForUpdates;

  if (spec.fade) {
    updateFadeTimer = setTimeout(() => {
      // Only dismiss if the state hasn't moved on since this paint.
      if (state.update && state.update.state === u.state) {
        state.update = { state: 'idle' };
        paintUpdatePill();
      }
    }, spec.fade);
  }
}

// Manual "check for updates" (titlebar): optimistically show "checking…" then
// ask main. Progress arrives back over onUpdateStatus.
function onCheckForUpdates() {
  if (!api.checkForUpdates) return;
  state.update = { state: 'checking' };
  paintUpdatePill();
  api.checkForUpdates();
}

// Subscribe once at boot. Each status event becomes the new state.update and
// repaints the persistent pill. Also wire the titlebar re-check control.
function setupUpdateEvents() {
  const check = document.getElementById('tb-check');
  if (check) {
    if (api.checkForUpdates) check.onclick = onCheckForUpdates;
    else check.hidden = true; // no bridge (browser preview with no mock)
  }
  // Titlebar "premium" opens the account/subscription screen.
  const premium = document.getElementById('tb-premium');
  if (premium) premium.onclick = () => go('account');
  if (!api.onUpdateStatus) return; // browser preview / mock: no push channel.
  api.onUpdateStatus((s) => {
    if (!s || !s.state) return;
    state.update = s;
    paintUpdatePill();
  });
}

/* boot: returning users with a configured network land on the cockpit; everyone
   else starts onboarding. The configured check is network-free on the main side
   (it inspects credential presence), so an unconfigured app reaches the welcome
   screen without any outbound call. */
async function boot() {
  setupUpdateEvents();
  try {
    const res = await api.cockpitSummary?.();
    const summary = res && res.ok ? res.summary : null;
    if (summary && summary.configured) {
      state.cockpit = summary;
      go('cockpit');
      return;
    }
  } catch {
    // fall through to onboarding
  }
  go('welcome');
}
boot();
