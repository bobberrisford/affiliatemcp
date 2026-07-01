/**
 * Brand Data Layer — public module surface.
 *
 * PR-1 ships the pure foundation: the derived model, the normaliser, the time
 * windows, the metric computation, and the rows cap. The adapter-touching pull,
 * the snapshot orchestrator, the local store, the entitlement stub, and CSV
 * land in later PRs of the workstream
 * (`docs/decisions/2026-06-30-brand-data-layer.md`).
 */

export * from './model.js';
export * from './normalise.js';
export * from './windows.js';
export * from './metrics.js';
export * from './rows-cap.js';
export * from './pull.js';
export * from './snapshot.js';
export * from './store.js';
