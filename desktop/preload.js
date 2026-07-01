// @ts-check
/**
 * Preload — exposes a narrow, typed facade to the renderer over contextBridge.
 * The renderer calls `window.affiliate.*`; nothing else from Node is reachable.
 * In a plain browser (no preload, e.g. the design preview) `window.affiliate`
 * is undefined and the renderer falls back to its built-in mock (see app.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('affiliate', {
  detectClients: () => ipcRenderer.invoke('clients:detect'),
  listNetworks: () => ipcRenderer.invoke('networks:list'),
  setupSteps: (slug) => ipcRenderer.invoke('networks:steps', slug),
  validateField: (slug, field, value) => ipcRenderer.invoke('networks:validateField', { slug, field, value }),
  verifyAuth: (slug, values) => ipcRenderer.invoke('networks:verifyAuth', { slug, values }),
  discoverBrands: (slug) => ipcRenderer.invoke('networks:discoverBrands', slug),
  // Skills: the bundled catalogue for the picker, and a local deploy into the
  // detected client's skills dir.
  listSkills: () => ipcRenderer.invoke('skills:list'),
  installSkills: (slugs) => ipcRenderer.invoke('skills:install', { slugs }),
  // Skill composer (build-your-own): archetype palette, per-network operations,
  // preview a generated SKILL.md, and save it locally.
  listSkillArchetypes: () => ipcRenderer.invoke('composer:archetypes'),
  listNetworkOperations: (slug) => ipcRenderer.invoke('composer:operations', slug),
  composeSkill: (input) => ipcRenderer.invoke('composer:compose', input),
  saveComposedSkill: (slug, content) => ipcRenderer.invoke('composer:save', { slug, content }),
  // Entitlement (paid tier). status/refresh are cheap; checkout/portal open the
  // system browser. Free-tier users (no account) never trigger a network call.
  entitlementStatus: () => ipcRenderer.invoke('entitlement:status'),
  refreshEntitlement: () => ipcRenderer.invoke('entitlement:refresh'),
  startCheckout: () => ipcRenderer.invoke('entitlement:checkout'),
  openPortal: () => ipcRenderer.invoke('entitlement:portal'),
  signOutEntitlement: () => ipcRenderer.invoke('entitlement:signout'),
  saveEnv: (entries) => ipcRenderer.invoke('config:saveEnv', entries),
  getTelemetryConsent: () => ipcRenderer.invoke('telemetry:getConsent'),
  setTelemetryConsent: (enabled) => ipcRenderer.invoke('telemetry:setConsent', enabled),
  saveBrands: (network, selections) => ipcRenderer.invoke('claude:saveBrands', { network, selections }),
  // Daily cockpit summary (attention flags) computed locally from network reads.
  cockpitSummary: () => ipcRenderer.invoke('cockpit:summary'),
  // Data locker (read-only): configured networks to pick from, then pull rows.
  lockerNetworks: () => ipcRenderer.invoke('locker:networks'),
  lockerEarnings: (slug, query, brand) => ipcRenderer.invoke('locker:earnings', { slug, query, brand }),
  lockerTransactions: (slug, query, brand) => ipcRenderer.invoke('locker:transactions', { slug, query, brand }),
  // Save already-pulled rows to a user-chosen local file (main owns the dialog).
  lockerExport: (suggestedName, content) => ipcRenderer.invoke('locker:export', { suggestedName, content }),
  // Open Claude with a pre-written prompt (the main process builds the URL).
  openClaudePrompt: (text) => ipcRenderer.invoke('claude:openPrompt', { text }),
  connectClaude: () => ipcRenderer.invoke('claude:connect'),
  restartClaude: () => ipcRenderer.invoke('claude:restart'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  // Auto-update. `onUpdateStatus` subscribes to main→renderer progress events
  // ({ state: 'checking' | 'downloading' | 'ready' | 'manual' | 'current' |
  //    'unavailable', … });
  // the actions check for updates, install a downloaded update, or open the
  // manual download page.
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  restartToUpdate: () => ipcRenderer.invoke('update:restart'),
  openUpdateDownload: () => ipcRenderer.invoke('update:openDownload'),
});
