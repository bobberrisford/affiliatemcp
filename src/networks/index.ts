/**
 * Network adapter aggregator.
 *
 * The single import point that triggers each adapter's `registerAdapter`
 * side effect. The MCP server and any tooling that wants the registry
 * populated should import this module.
 *
 * Adding a new network is intentionally one line: import its adapter file.
 * The act of importing causes the file's top-level `registerAdapter` call
 * to run, registering the adapter with the shared registry.
 *
 * If you want to programmatically enable / disable networks at runtime,
 * do NOT do it here — add a feature flag in the import path of whichever
 * entry consumes the registry. This file's job is to BE the list.
 */

import './awin/adapter.js';
import './cj/adapter.js';
