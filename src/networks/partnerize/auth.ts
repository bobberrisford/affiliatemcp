/**
 * Partnerize auth + credential validation.
 *
 * Partnerize uses HTTP Basic authentication with two credentials:
 *   - `PARTNERIZE_APPLICATION_KEY` — identifies the network partition. Found in
 *     the Partnerize console under Settings → Account Settings → User Application Key.
 *   - `PARTNERIZE_USER_API_KEY`    — identifies the user. Found in the Partnerize
 *     console under Settings → Account Settings → User API Key.
 *   - `PARTNERIZE_PUBLISHER_ID`    — the publisher account ID. Used as a path
 *     segment in every reporting endpoint. Can be derived from the API response.
 *
 * The auth-check endpoint is `GET /user/publisher/{publisher_id}`, which is
 * the cheapest publisher-identifying call in the Partnerize surface. If the
 * publisher ID is not yet known we fall back to `GET /user/publisher` (list)
 * to discover it, then surface it as a `derivedValue`.
 *
 * --- The `derivedValues` pattern --------------------------------------------
 *
 * Partnerize's API requires the publisher ID as a URL path segment in every
 * reporting call. The user typically knows their application_key and user_api_key
 * from the dashboard but may not know their numeric publisher_id. We derive it
 * from `GET /user/publisher` and surface it as `PARTNERIZE_PUBLISHER_ID` in
 * the verifyAuth response so the wizard can persist it without an extra prompt.
 */

import { partnerizeRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnerize.auth');

/**
 * The minimal shape we read from `GET /user/publisher`.
 * Partnerize wraps the list in a `publishers` key.
 * Endpoint path confirmed from publisher.apib; field names `publisher_id` and
 * `account_name` confirmed from publisher.apib blueprint. Not live-tested.
 */
interface PartnerizePublisher {
  publisher_id?: string;
  account_name?: string;
  status?: string;
}

interface PartnerizePublisherListResponse {
  publishers?: {
    publisher?: PartnerizePublisher[];
  };
  // Direct array in some response variants.
  publisher?: PartnerizePublisher[];
}

/**
 * Successful verifyAuth result. `derivedValues` is consumed by the setup wizard
 * to persist PARTNERIZE_PUBLISHER_ID without asking the user to enter it manually.
 */
export interface VerifyAuthOk {
  ok: true;
  identity?: string;
  derivedValues?: { PARTNERIZE_PUBLISHER_ID?: string };
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify the Partnerize credentials by calling `GET /user/publisher`.
 *
 * Why this endpoint:
 *   - It is the smallest authenticated call that also returns publisher IDs,
 *     enabling the `derivedValues` flow.
 *   - It rejects with 401 on bad credentials — clean, actionable signal.
 *   - POST /user/publisher/{id} requires knowing the ID first, so the list
 *     endpoint is the right starting point during setup.
 *
 * On success we attempt to derive `PARTNERIZE_PUBLISHER_ID`. If the response
 * returns multiple publishers the first one is used (or the existing env value
 * if already set).
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let applicationKey: string;
  let userApiKey: string;
  try {
    applicationKey = requireCredential('PARTNERIZE_APPLICATION_KEY', {
      network: 'partnerize',
      operation: 'verifyAuth',
      hint: 'Find your Application Key in the Partnerize console → Settings → Account Settings → User Application Key.',
    });
    userApiKey = requireCredential('PARTNERIZE_USER_API_KEY', {
      network: 'partnerize',
      operation: 'verifyAuth',
      hint: 'Find your User API Key in the Partnerize console → Settings → Account Settings → User API Key.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await partnerizeRequest<PartnerizePublisherListResponse>({
      operation: 'verifyAuth',
      path: '/user/publisher',
      applicationKey,
      userApiKey,
      resilience: DEFAULT_RESILIENCE,
    });

    const publishers = extractPublisherList(response);
    const publisherId = pickPublisherId(publishers);

    log.debug({ count: publishers.length, publisherId }, 'partnerize verifyAuth succeeded');

    const firstName = publishers[0]?.account_name;
    const identity = publisherId
      ? firstName
        ? `partnerize/${publisherId} (${firstName})`
        : `partnerize/${publisherId}`
      : 'partnerize (no publisher accounts found)';

    return {
      ok: true,
      identity,
      derivedValues: publisherId ? { PARTNERIZE_PUBLISHER_ID: publisherId } : undefined,
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'partnerize',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Normalise the various shapes Partnerize uses to wrap the publisher list.
 *
 * The API blueprint shows `{ publishers: { publisher: [...] } }` but live
 * responses may differ; we read both known shapes defensively.
 * Envelope shape sourced from publisher.apib; not confirmed against a live account.
 * Blocked: requires live credentials to confirm exact envelope.
 */
function extractPublisherList(response: PartnerizePublisherListResponse): PartnerizePublisher[] {
  // Shape 1: { publishers: { publisher: [...] } }
  if (response?.publishers?.publisher && Array.isArray(response.publishers.publisher)) {
    return response.publishers.publisher;
  }
  // Shape 2: { publisher: [...] }
  if (response?.publisher && Array.isArray(response.publisher)) {
    return response.publisher;
  }
  return [];
}

/**
 * Pick the publisher ID to use for subsequent calls.
 *
 * Priority:
 *   1. Already set in env (`PARTNERIZE_PUBLISHER_ID`) — respect operator intent.
 *   2. First publisher in the API response.
 *   3. Undefined — derivation not possible.
 */
function pickPublisherId(publishers: PartnerizePublisher[]): string | undefined {
  const existing = getCredential('PARTNERIZE_PUBLISHER_ID');
  if (existing) return existing;
  const first = publishers[0];
  return first?.publisher_id ?? undefined;
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * - `PARTNERIZE_APPLICATION_KEY`: writes the candidate into `process.env`,
 *   runs `verifyAuth()` (which requires both keys). Defers if user_api_key
 *   is not yet set.
 * - `PARTNERIZE_USER_API_KEY`: writes the candidate into `process.env`, runs
 *   `verifyAuth()` if application_key is already set. Otherwise: format check only.
 * - `PARTNERIZE_PUBLISHER_ID`: format check — must be a non-empty string of
 *   digits.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'PARTNERIZE_APPLICATION_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Partnerize Application Key is required.',
        hint: 'Find it in the Partnerize console → Settings → Account Settings → User Application Key.',
      };
    }
    // If the user_api_key is already set we can do a live check.
    const apiKey = process.env['PARTNERIZE_USER_API_KEY'];
    if (!apiKey) {
      return {
        ok: true,
        message: 'Application Key format accepted; live validation deferred until User API Key is set.',
      };
    }
    const previous = process.env['PARTNERIZE_APPLICATION_KEY'];
    process.env['PARTNERIZE_APPLICATION_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'application key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the Application Key in the Partnerize console → Settings → Account Settings.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['PARTNERIZE_APPLICATION_KEY'];
      } else {
        process.env['PARTNERIZE_APPLICATION_KEY'] = previous;
      }
    }
  }

  if (field === 'PARTNERIZE_USER_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Partnerize User API Key is required.',
        hint: 'Find it in the Partnerize console → Settings → Account Settings → User API Key.',
      };
    }
    const appKey = process.env['PARTNERIZE_APPLICATION_KEY'];
    if (!appKey) {
      return {
        ok: true,
        message: 'User API Key format accepted; live validation deferred until Application Key is set.',
      };
    }
    const previous = process.env['PARTNERIZE_USER_API_KEY'];
    process.env['PARTNERIZE_USER_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'user API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the User API Key in the Partnerize console → Settings → Account Settings. ' +
          'The key may be revoked or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['PARTNERIZE_USER_API_KEY'];
      } else {
        process.env['PARTNERIZE_USER_API_KEY'] = previous;
      }
    }
  }

  if (field === 'PARTNERIZE_PUBLISHER_ID') {
    if (!value || !/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Partnerize Publisher ID must be a positive integer.',
        hint: 'Your publisher ID appears in the Partnerize console URL after login, e.g. /publisher/1234567.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Partnerize.`,
    hint: 'Partnerize expects PARTNERIZE_APPLICATION_KEY, PARTNERIZE_USER_API_KEY (both required), and PARTNERIZE_PUBLISHER_ID (auto-derived).',
  };
}
