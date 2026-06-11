import { defineConfig } from '@playwright/test';

// Electron end-to-end tests. These launch the REAL packaged main process and
// drive it through the REAL preload bridge — the path the browser-only renderer
// mock cannot exercise (and where several runtime-only bugs have hidden: an
// un-awaited async IPC handler, structured-result handling, the openExternal
// allowlist). One worker: a single Electron instance per run, tests sequential.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
