/**
 * affiliate-mcp desktop — single core entry for the Electron app.
 *
 * The packaged Electron app does NOT ship `node_modules` or a `"type":"module"`
 * marker, so it cannot dynamic-import the raw ESM `dist/` tree. Instead, esbuild
 * bundles THIS module into a self-contained CommonJS file (`build/core.cjs`)
 * that `desktop/main.js` loads with `require()`.
 *
 * It re-exports EVERY symbol `main.js` consumes off the `facade`/`config`
 * objects, flattened onto one module so the existing `facade.*`/`config.*`
 * call sites keep working unchanged.
 */

// Everything main.js calls as `facade.*`:
//   listNetworks, setupSteps, validateField, verifyAuth, discoverBrands,
//   saveEnv, saveBrands, connectClaudeDesktop, detectClients, telemetry consent.
export * from './facade.js';

// Config symbols main.js may reference as `config.*`:
export { CONFIG_DIR } from '../shared/config.js';
