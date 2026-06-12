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
  saveEnv: (entries) => ipcRenderer.invoke('config:saveEnv', entries),
  getTelemetryConsent: () => ipcRenderer.invoke('telemetry:getConsent'),
  setTelemetryConsent: (enabled) => ipcRenderer.invoke('telemetry:setConsent', enabled),
  saveBrands: (network, selections) => ipcRenderer.invoke('claude:saveBrands', { network, selections }),
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
