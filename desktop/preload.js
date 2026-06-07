// @ts-check
/**
 * Preload — exposes a narrow, typed facade to the renderer over contextBridge.
 * The renderer calls `window.affiliate.*`; nothing else from Node is reachable.
 * In a plain browser (no preload, e.g. the design preview) `window.affiliate`
 * is undefined and the renderer falls back to its built-in mock (see app.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('affiliate', {
  licence: {
    read: () => ipcRenderer.invoke('licence:read'),
    activate: (key) => ipcRenderer.invoke('licence:activate', key),
    buy: () => ipcRenderer.invoke('licence:buy'),
  },
  detectClients: () => ipcRenderer.invoke('clients:detect'),
  listNetworks: () => ipcRenderer.invoke('networks:list'),
  setupSteps: (slug) => ipcRenderer.invoke('networks:steps', slug),
  validateField: (slug, field, value) => ipcRenderer.invoke('networks:validateField', { slug, field, value }),
  verifyAuth: (slug, values) => ipcRenderer.invoke('networks:verifyAuth', { slug, values }),
  discoverBrands: (slug) => ipcRenderer.invoke('networks:discoverBrands', slug),
  saveEnv: (entries) => ipcRenderer.invoke('config:saveEnv', entries),
  saveBrands: (network, selections) => ipcRenderer.invoke('claude:saveBrands', { network, selections }),
  connectClaude: () => ipcRenderer.invoke('claude:connect'),
  restartClaude: () => ipcRenderer.invoke('claude:restart'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
