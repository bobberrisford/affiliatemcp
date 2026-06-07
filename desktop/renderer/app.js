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
    licence: {
      read: () => wait(null),
      activate: (key) => wait(typeof key === 'string' && key.startsWith('amcp_') && key.length > 20
        ? { ok: true, licence: { email: 'buyer@example.com', issued: '2026-06-07' } }
        : { ok: false, error: 'That key could not be verified. Check it and try again.' }, 600),
      buy: () => { window.open('https://example.com/checkout-placeholder', '_blank'); return wait({ ok: true }); },
    },
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
    discoverBrands: () => wait(MOCK_BRANDS, 500),
    saveEnv: (_entries) => wait({ ok: true }),
    saveBrands: (_network, selections) => wait({ ok: true, count: (selections || []).length }),
    connectClaude: () => wait({ ok: true, action: 'added', backupPath: '…/claude_desktop_config.json.bak' }, 500),
    restartClaude: () => wait({ ok: true }),
    quit: () => wait({ ok: true }),
  };
}
const api = window.affiliate || mockApi();

/* ---- state ------------------------------------------------------------ */
const state = {
  screen: 'activate',
  licence: null,
  networks: [],
  selected: [],          // slugs
  credIndex: 0,          // index into selected[]
  verified: {},          // slug -> identity
  brands: [],            // discovered
  brandSel: {},          // id -> { on, nick }
  envEntries: {},        // FIELD -> value, accumulated across verified networks
};
const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FLOW = ['networks', 'credentials', 'brands', 'connect'];
function rail(current) {
  const i = FLOW.indexOf(current);
  return `<div class="steps"><span class="stepno">step ${i + 1} / ${FLOW.length}</span>` +
    FLOW.map((_, k) => `<span class="seg ${k <= i ? 'on' : ''}"></span>`).join('') + `</div>`;
}
const wrap = (body, center) => `<div class="screen ${center ? 'center' : ''} fade"><div class="scroll">${body}</div></div>`;

/* ---- screens ---------------------------------------------------------- */
function renderActivate() {
  app.innerHTML = wrap(`
    <img class="bigmark" src="${MARK}" alt="" />
    <h1 class="welcome-h">activate affiliate-mcp.</h1>
    <p class="scr-lead" style="margin-inline:auto">a one-off £39 licence. paste the key from your email, or buy it now — it’s yours for life, no subscription.</p>
    <div class="kv" style="max-width:520px;margin:0 auto"><span class="pre">licence</span><input id="key" placeholder="amcp_…" autocomplete="off" spellcheck="false" /></div>
    <div class="verify-row" id="lic-status" style="text-align:center;margin-top:14px"></div>
    <div class="trust"><span class="chip">● OFFLINE LICENCE</span><span class="chip">● NO TELEMETRY</span><span class="chip acid">SOURCE STAYS OPEN</span></div>
    <div style="display:flex;gap:14px;justify-content:center">
      <button class="btn btn-ghost" id="buy">buy — £39</button>
      <button class="btn btn-primary" id="activate">activate ▸</button>
    </div>
  `, true);
  const status = document.getElementById('lic-status');
  const keyInput = /** @type {HTMLInputElement} */(document.getElementById('key'));
  document.getElementById('buy').onclick = () => api.licence.buy();
  // The single activate routine — shared by the button and the deep-link path
  // so there's exactly one place that verifies + advances. Guards re-entry.
  let activating = false;
  async function activate() {
    if (activating) return;
    const key = keyInput.value.trim();
    if (!key) return;
    activating = true;
    status.innerHTML = `<span class="status"><span class="dot dot-pending"></span> checking…</span>`;
    const res = await api.licence.activate(key);
    if (res && res.ok) {
      state.licence = res.licence;
      status.innerHTML = `<span class="status"><span class="dot dot-pos"></span> verified offline</span>`;
      setTimeout(() => go('welcome'), 450);
    } else {
      activating = false;
      status.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc((res && res.error) || 'invalid key')}</span>`;
    }
  }
  document.getElementById('activate').onclick = activate;
  // A deep link may have delivered a key — either queued before this screen
  // rendered (cold launch) or while it's already showing (the boot-level
  // subscriber re-renders us). Prefill + auto-activate it exactly once.
  if (incomingKey) { keyInput.value = incomingKey; incomingKey = null; activate(); }
}

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

async function renderNetworks() {
  if (!state.networks.length) state.networks = await api.listNetworks();
  const tiles = state.networks.map((n) => {
    const on = state.selected.includes(n.slug);
    return `<div class="net ${on ? 'sel' : ''}" data-slug="${n.slug}"><span class="tick">✓</span>
      <div class="nm">${esc(n.name)}</div>
      <div class="mt">~${n.setupMinutes} min · ${esc(n.side)}${n.approval ? ' · approval' : ''}</div></div>`;
  }).join('');
  app.innerHTML = wrap(`
    ${rail('networks')}
    <h2 class="scr">which networks do you use?</h2>
    <p class="scr-lead">pick any number. we’ll walk you through each one. publisher or brand side — both work.</p>
    <div class="grid">${tiles}</div>
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="next">continue ▸</button>
    </div>
  `);
  app.querySelectorAll('.net').forEach((tile) => {
    tile.addEventListener('click', () => {
      const slug = tile.getAttribute('data-slug');
      const i = state.selected.indexOf(slug);
      if (i >= 0) state.selected.splice(i, 1); else state.selected.push(slug);
      renderNetworks();
    });
  });
  document.getElementById('back').onclick = () => go('welcome');
  const next = /** @type {HTMLButtonElement} */(document.getElementById('next'));
  next.textContent = state.selected.length ? `${state.selected.length} selected — continue ▸` : 'continue ▸';
  next.disabled = state.selected.length === 0;
  next.onclick = () => { state.credIndex = 0; go('credentials'); };
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
  app.querySelectorAll('.deeplink').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const url = a.getAttribute('data-url');
    if (window.affiliate) window.open(url, '_blank'); else window.open(url, '_blank');
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
        else go(anyBrandSide() ? 'brands' : 'connect');
      }, 550);
    } else {
      vs.innerHTML = `<span class="status"><span class="dot dot-neg"></span> ${esc((res && res.reason) || 'could not verify')}</span>`;
    }
  };
}

const anyBrandSide = () => state.selected.some((s) => (state.networks.find((n) => n.slug === s) || {}).side === 'brand');

async function renderBrands() {
  const brandNetworkSlug = state.selected.find((s) => (state.networks.find((n) => n.slug === s) || {}).side === 'brand');
  if (!state.brands.length) {
    state.brands = await api.discoverBrands(brandNetworkSlug);
    state.brands.forEach((b) => { state.brandSel[b.id] = { on: b.status === 'active', nick: b.name.split(' ')[0].toLowerCase() }; });
  }
  const rows = state.brands.map((b) => {
    const sel = state.brandSel[b.id];
    const dot = b.status === 'active' ? 'dot-pos' : 'dot-pending';
    return `<div class="brow ${sel.on ? '' : 'off'}" data-id="${b.id}">
      <span class="cb">✓</span><span class="bn">${esc(b.name)}</span>
      <span class="status" style="margin-left:14px"><span class="dot ${dot}"></span> ${esc(b.status)}</span>
      <span class="nick"><input data-nick="${b.id}" value="${esc(sel.nick)}" placeholder="nickname" /></span>
    </div>`;
  }).join('');
  app.innerHTML = wrap(`
    ${rail('brands')}
    <h2 class="scr">which brands can these keys reach?</h2>
    <p class="scr-lead">your credentials see these advertiser accounts. pick the ones you manage and give each a nickname you’ll use when you ask questions.</p>
    ${rows}
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="next">save brands — continue ▸</button>
    </div>
  `);
  app.querySelectorAll('.brow').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const id = row.getAttribute('data-id');
    state.brandSel[id].on = !state.brandSel[id].on;
    renderBrands();
  }));
  app.querySelectorAll('[data-nick]').forEach((inp) => inp.addEventListener('input', () => {
    state.brandSel[inp.getAttribute('data-nick')].nick = inp.value;
  }));
  document.getElementById('back').onclick = () => { state.credIndex = state.selected.length - 1; go('credentials'); };
  document.getElementById('next').onclick = async () => {
    const selections = state.brands
      .filter((b) => state.brandSel[b.id] && state.brandSel[b.id].on)
      .map((b) => ({ networkBrandId: b.id, slug: state.brandSel[b.id].nick }));
    await api.saveBrands(brandNetworkSlug, selections);
    go('connect');
  };
}

async function renderConnect() {
  const det = await api.detectClients();
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
    <div class="verify-row" id="cstatus"></div>
    <div class="actions">
      <button class="btn btn-ghost" id="back">back</button>
      <button class="btn btn-primary" id="go" ${present ? '' : 'disabled'}>connect &amp; restart Claude ▸</button>
    </div>
  `);
  document.getElementById('back').onclick = () => go(anyBrandSide() ? 'brands' : 'credentials');
  const goBtn = document.getElementById('go');
  if (goBtn) goBtn.onclick = async () => {
    const cs = document.getElementById('cstatus');
    cs.innerHTML = `<span class="status"><span class="dot dot-pending"></span> writing config…</span>`;
    await api.saveEnv(state.envEntries);
    await api.connectClaude();
    await api.restartClaude();
    go('done');
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

/* ---- router ----------------------------------------------------------- */
const SCREENS = {
  activate: renderActivate, welcome: renderWelcome, networks: renderNetworks,
  credentials: renderCredentials, brands: renderBrands, connect: renderConnect, done: renderDone,
};
function go(name) { state.screen = name; (SCREENS[name] || renderActivate)(); }

/* ---- deep-link key (affiliate-mcp://activate?key=…) ------------------ */
// A key can arrive from main before renderActivate runs (cold launch via the
// link). Stash the latest here; renderActivate consumes + auto-activates it.
// If it arrives once we're already past the gate (licensed), it's ignored.
let incomingKey = null;
api.onIncomingKey?.((key) => {
  if (state.screen === 'activate') {
    incomingKey = key;
    renderActivate(); // re-render so it picks up + auto-activates the key
  }
  // else: already licensed / mid-flow — the renderActivate subscriber handles
  // the on-screen case; anything later is intentionally ignored.
});

/* boot: skip the gate if already licensed */
(async () => {
  const lic = await api.licence.read();
  if (lic && lic.email) { state.licence = lic; go('welcome'); }
  else go('activate');
})();
