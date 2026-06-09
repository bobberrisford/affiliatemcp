/**
 * Template: setup steps + credential validation for <NETWORK_NAME>.
 *
 * Define the prompts the wizard shows, and how each field is validated live
 * against the network's API. Keep `validateOnEntry` fast — the wizard calls it
 * synchronously between prompts.
 *
 * Reference: src/networks/awin/setup.ts (single-credential, derives the
 * second via verifyAuth);
 *            src/networks/cj/setup.ts (two credentials, both prompted);
 *            src/networks/rakuten/setup.ts (three credentials including OAuth
 *            client id + secret, mentions approval timing in description).
 *
 * Each SetupStep must include:
 *   - `field` — the env-var name. Must match an entry in network.json
 *     `env_vars` and the field your auth.ts reads via `requireCredential`.
 *   - `label` — short, sentence-case ("Awin API token").
 *   - `description` — verbatim dashboard navigation. Use real button names
 *     ("Click Account → API → Generate token"). Do not paraphrase.
 *   - `type` — `password` for secrets, `text` for IDs, `number` for numerics.
 *   - `example` — optional but recommended; shows the expected shape.
 *   - `validateOnEntry` — a live check where feasible. Return
 *     CredentialValidationResult.
 *
 * API behaviour to verify:
 *   - Which credentials must the user enter, and in what order?
 *   - Can any field be format-validated without an API call (length /
 *     character set) to save round trips?
 *   - For OAuth2: validating the client id requires the secret — defer the
 *     id step's live check until the secret is entered (return `{ ok: true,
 *     message: 'will validate after secret' }`). See Rakuten setup.
 *
 * Approval-gated networks: mention the approval window in the description of
 * the FIRST step so the user with an un-provisioned account learns about it
 * before the wizard fails to validate.
 */

import type { SetupStep } from '../../shared/types.js';

// TODO: enumerate prompts. Each step should have a `validateOnEntry` where the
// network's API allows a per-field live check.
export const SETUP_STEPS: SetupStep[] = [];

// TODO: export function setupSteps(): SetupStep[] { return SETUP_STEPS; }
export function setupSteps(): SetupStep[] {
  return SETUP_STEPS;
}
