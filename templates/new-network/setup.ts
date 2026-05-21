/**
 * Template: setup steps + credential validation for <NETWORK_NAME>.
 *
 * Define the prompts the wizard shows, and how each field is validated live
 * against the network's API. Keep `validateOnEntry` fast — the wizard calls it
 * synchronously between prompts.
 */

import type { SetupStep } from '../../src/shared/types.js';

// TODO: enumerate prompts. Each step should have a `validateOnEntry` if possible.
export const SETUP_STEPS: SetupStep[] = [];
