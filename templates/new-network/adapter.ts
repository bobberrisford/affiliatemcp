/**
 * Template: <NETWORK_NAME> adapter.
 *
 * READ ME FIRST.
 *
 * This file is the structural skeleton. Each TODO block below names the Awin
 * equivalent and the questions you must answer about your network's API
 * before writing the operation. Awin (`src/networks/awin/adapter.ts`) is the
 * canonical reference; do not invent a different shape for your adapter.
 *
 * Workflow:
 *   1. Copy this folder to `src/networks/<slug>/`.
 *   2. Replace `TEMPLATE_NETWORK` everywhere with your slug.
 *   3. Implement `auth.ts` and `client.ts` first.
 *   4. Implement the seven operations in the order listed in the contribute
 *      skill (`.claude/skills/contribute/SKILL.md` step 6).
 *   5. Wire the adapter into `src/networks/index.ts` (one line).
 *
 * Six cardinal rules (see Awin's file header for the full reasoning):
 *
 *   1. Never call `fetch` directly outside `client.ts`. Use the resilience
 *      layer via your `client.ts` helper.
 *   2. Every failure must round-trip through a `NetworkErrorEnvelope` with
 *      `network`, `operation`, `httpStatus`, and the verbatim
 *      `networkErrorBody`. Never collapse to "an error occurred"
 *      (principle 4.1).
 *   3. Preserve the upstream response in `rawNetworkData` on every domain
 *      object. Debugging is impossible if we throw away what the network
 *      actually returned.
 *   4. Normalise status enums to the canonical set in `src/shared/types.ts`.
 *      Document the mapping inline. Prefer `unknown` over a wrong guess.
 *   5. Compute `ageDays` for every transaction (PRD §15.9).
 *   6. UK English in every user-visible string. The user-visible noun is
 *      "programme", not "program".
 */

import type {
  Click,
  ClickQuery,
  CredentialValidationResult,
  DerivedValueResult,
  DiscoveredBrand,
  EarningsSummary,
  NetworkAdapter,
  NetworkCapabilities,
  NetworkMeta,
  Programme,
  ProgrammeQuery,
  ResilienceConfigMap,
  SetupStep,
  TrackingLink,
  Transaction,
  TransactionQuery,
} from '../../shared/types.js';
import { NotImplementedError } from '../../shared/types.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';

// TODO: replace with the real slug. Must match the directory name under
// `src/networks/` and the `slug` field in `network.json`.
const SLUG = 'TEMPLATE_NETWORK';

const META: NetworkMeta = {
  slug: SLUG,
  // TODO: human-readable name shown in tool descriptions, e.g. "eBay Partner Network".
  name: 'TEMPLATE_NETWORK',
  // TODO: production base URL of the network API.
  baseUrl: 'https://api.example.com',
  // TODO: one of `bearer | oauth2 | basic | custom`. Must match `auth_model`
  // in network.json.
  authModel: 'bearer',
  // TODO: bump `0.1.0` once the adapter has been live-validated.
  adapterVersion: '0.0.1',
  // TODO: `experimental` for a fresh adapter, `partial` once the seven ops
  // are implemented and the diagnostic passes, `production` only after a
  // live acceptance test against a real publisher account.
  claimStatus: 'experimental',
  // TODO: enumerate ops that are intentionally unsupported, with one-line
  // reasons. Mirror the strings in network.json.
  knownLimitations: [],
  // TODO: false at v0.1 for every network. Set true only when brand-side
  // ops are implemented (v0.2+).
  supportsBrandOps: false,
  // TODO: honest estimate for a user who already has the dashboard open.
  setupTimeEstimateMinutes: 10,
  // TODO: true if the network gates API access behind manual approval.
  setupRequiresApproval: false,
  // TODO: which side of the affiliate relationship this adapter integrates with.
  // `publisher` for adapters that act on behalf of a publisher account (the
  // norm at v0.1); `advertiser` reserved for future brand-side adapters.
  // Inert metadata at this stage — no code path branches on it yet.
  side: 'publisher',
  // TODO: whether a single set of credentials addresses one brand or many.
  // `single-brand` for one publisher account per credentials set (the norm
  // at v0.1); `multi-brand` reserved for network credentials that span
  // multiple brands. Inert metadata at this stage — no code path branches
  // on it yet.
  credentialScope: 'single-brand',
};

export class TemplateNetworkAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = META.name;
  readonly meta = META;
  // TODO: override per-operation if your network has a slow endpoint (e.g.
  // Awin gives `listTransactions` a 60s timeout). See Awin's `RESILIENCE`.
  readonly resilienceConfig: ResilienceConfigMap = { default: DEFAULT_RESILIENCE };

  // TODO: Implement listProgrammes.
  //
  // What to do:
  //   Call your network's "list programmes" or equivalent endpoint via
  //   client.ts. Transform each programme into the Programme type from
  //   src/shared/types.ts. Apply client-side filters for query.search,
  //   query.status, query.categories, query.limit if the API does not
  //   support them server-side.
  //
  // Reference: src/networks/awin/adapter.ts::listProgrammes — this is the
  // pattern.
  //
  // API behaviour to verify:
  //   - Does the network return programme metadata in one call, or do you
  //     need a follow-up call per programme for the structured commission
  //     data?
  //   - Is pagination cursor-based, offset-based, or absent?
  //   - Are commission rates exposed numerically or as free-form strings?
  //   - Does the network's "available" / "joined" filter map cleanly to
  //     ProgrammeStatus? Document the mapping in a helper like Awin's
  //     `mapProgrammeStatus`.
  //
  // Error handling:
  //   If the API is reachable but the response is malformed, construct a
  //   NetworkErrorEnvelope with type 'network_api_error' and surface the
  //   raw response in networkErrorBody via NetworkError.
  //
  // Return type: Promise<Programme[]> — see src/shared/types.ts.
  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    throw new NotImplementedError(`${SLUG}.listProgrammes is not yet implemented.`);
  }

  // TODO: Implement getProgramme.
  //
  // What to do:
  //   Fetch a single programme by ID via client.ts. Transform into Programme.
  //   Validate the ID format before calling — invalid input should surface
  //   as a config_error envelope, not a 400 from the network.
  //
  // Reference: src/networks/awin/adapter.ts::getProgramme.
  //
  // API behaviour to verify:
  //   - Is the programme ID a path segment or a query parameter?
  //   - Does the response wrap the programme in an envelope (Awin uses
  //     `programmeInfo`) or return it flat?
  //   - What does the network return for an unknown ID — 404, 200 with an
  //     empty body, or 200 with an "not found" string?
  //
  // Error handling:
  //   For an invalid ID format, throw NetworkError with a config_error
  //   envelope and a hint pointing the caller at the discovery operation
  //   (listProgrammes). For an unknown ID, throw a network_api_error
  //   envelope; do not silently return a stub object.
  //
  // Return type: Promise<Programme> — see src/shared/types.ts.
  async getProgramme(_programmeId: string): Promise<Programme> {
    throw new NotImplementedError(`${SLUG}.getProgramme is not yet implemented.`);
  }

  // TODO: Implement listTransactions.
  //
  // What to do:
  //   Call the transactions endpoint via client.ts for the window query.from
  //   to query.to. Transform each row into Transaction. Compute ageDays
  //   anchored on the approved / validation date if the network exposes one,
  //   otherwise the conversion date.
  //
  // Reference: src/networks/awin/adapter.ts::listTransactions. Pay
  // particular attention to `chunkDateRange` (Awin caps a single call at
  // 31 days; if your network has a similar cap, replicate the chunking).
  //
  // API behaviour to verify:
  //   - Is there a maximum window per call? (Awin: 31 days. CJ: open-ended
  //     via GraphQL.)
  //   - Does the endpoint accept a status filter, or must we filter client-side?
  //   - Does the endpoint accept a programme filter?
  //   - Is the date format ISO-8601 to the second, milliseconds-included,
  //     or something idiosyncratic?
  //   - Is there an explicit "paid" flag, or do you derive paid status from
  //     a payment ID? (Awin: derives from `paidToPublisher: true`.)
  //   - For reversed transactions, where is the reason exposed? Surface it
  //     in `reversalReason` (PRD §15.10).
  //
  // Error handling:
  //   Apply minAgeDays / maxAgeDays filters AFTER status filtering so a
  //   query like `{ status: 'approved', minAgeDays: 180 }` is meaningful.
  //   Do not silently undercount — never apply `query.limit` before
  //   computing aggregates if this op feeds into getEarningsSummary.
  //
  // Return type: Promise<Transaction[]> — see src/shared/types.ts.
  async listTransactions(_query?: TransactionQuery): Promise<Transaction[]> {
    throw new NotImplementedError(`${SLUG}.listTransactions is not yet implemented.`);
  }

  // TODO: Implement getEarningsSummary.
  //
  // What to do:
  //   Derive the summary from listTransactions by default. Compute
  //   byProgramme totals, byStatus totals, and oldestUnpaidAgeDays (the
  //   maximum ageDays among transactions whose status is pending or
  //   approved). Use commission, not sale amount.
  //
  // Reference: src/networks/awin/adapter.ts::getEarningsSummary — read the
  // "why we derive from listTransactions" comment carefully. The user must
  // be able to reproduce the summary by calling listTransactions themselves.
  //
  // API behaviour to verify:
  //   - Does your network have a separate "report" endpoint?
  //   - If yes: do its status buckets match the per-transaction statuses?
  //     If no, prefer deriving from listTransactions — two sources of truth
  //     is worse than one slow source.
  //
  // Error handling:
  //   Do NOT pass query.limit through to listTransactions inside this op;
  //   a summary with a limit silently undercounts (principle 4.1).
  //
  // Return type: Promise<EarningsSummary> — see src/shared/types.ts.
  async getEarningsSummary(_query?: TransactionQuery): Promise<EarningsSummary> {
    throw new NotImplementedError(`${SLUG}.getEarningsSummary is not yet implemented.`);
  }

  // TODO: Implement listClicks.
  //
  // What to do:
  //   Call the click data endpoint via client.ts. Transform each row into
  //   Click. If the network does not expose click data via its public API
  //   (Awin, CJ), throw NotImplementedError with a one-line reason — do
  //   NOT return an empty array. The difference between "no clicks" and
  //   "no API" is principle 4.1.
  //
  // Reference: src/networks/awin/adapter.ts::listClicks for the
  // unsupported case; src/networks/impact/adapter.ts::listClicks for an
  // implemented case.
  //
  // API behaviour to verify:
  //   - Does the network expose click-level data via its publisher API?
  //   - Is access gated (Rakuten gates clicks behind a paid tier)? Document
  //     this in network.json `known_limitations`.
  //   - What date window is supported?
  //
  // Error handling:
  //   If unsupported, throw NotImplementedError with a reason. Add the
  //   limitation to META.knownLimitations AND network.json.
  //
  // Return type: Promise<Click[]> — see src/shared/types.ts.
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    throw new NotImplementedError(`${SLUG}.listClicks is not yet implemented.`);
  }

  // TODO: Implement generateTrackingLink.
  //
  // What to do:
  //   Produce a TrackingLink for `input.programmeId` pointing at
  //   `input.destinationUrl`. Prefer deterministic URL construction (Awin)
  //   over an API round-trip (Impact). Validate inputs before doing
  //   anything — empty programmeId or destinationUrl must surface as a
  //   config_error envelope with a clear hint.
  //
  // Reference: src/networks/awin/adapter.ts::generateTrackingLink for the
  // deterministic case; src/networks/impact/adapter.ts::generateTrackingLink
  // for the API-call case.
  //
  // API behaviour to verify:
  //   - Is the tracking URL deterministically constructible from
  //     (publisherId, programmeId, destinationUrl), or does it require an
  //     API call?
  //   - What parameters does the URL accept? (Awin: awinmid, awinaffid, ued.)
  //   - Are sub-IDs supported?
  //
  // Error handling:
  //   Validate inputs first. Even for deterministic construction, require
  //   the auth credential to be configured so users with a half-configured
  //   environment learn at link-generation time, not at first-click time.
  //
  // Return type: Promise<TrackingLink> — see src/shared/types.ts. Include
  //   the construction context in rawNetworkData if no upstream call was
  //   made.
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    throw new NotImplementedError(`${SLUG}.generateTrackingLink is not yet implemented.`);
  }

  // TODO: Implement verifyAuth.
  //
  // What to do:
  //   Delegate to a `verifyAuth` helper in auth.ts. The helper makes a
  //   cheap, identity-revealing call (e.g. /me, /publishers) and returns
  //   the identity on success or a reason on failure. The adapter surface
  //   returns the contract type
  //   `{ ok: true, identity? } | { ok: false, reason }`.
  //
  // Reference: src/networks/awin/adapter.ts::verifyAuth + auth.ts.
  //
  // API behaviour to verify:
  //   - What is the cheapest identity-revealing endpoint? Use it.
  //   - Can verifyAuth derive a second credential (e.g. publisherId) for
  //     the wizard? If yes, expose it via derivedValues() below.
  //
  // Error handling:
  //   On a 401, return { ok: false, reason: '<verbatim upstream>' } — do
  //   not throw. verifyAuth is itself called by error handlers; throwing
  //   from here loops.
  //
  // Return type: Promise<{ ok: true; identity?: string } | { ok: false; reason: string }>.
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    return { ok: false, reason: 'not implemented' };
  }

  // Admin operations — keep as NotImplementedError at v0.1 for every
  // network. Brand-side support lights up in v0.2 once a network claims it.
  async listPublishers(): Promise<never> {
    throw new NotImplementedError('listPublishers is admin-only and not exposed at v0.1.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('listPublisherSectors is admin-only and not exposed at v0.1.');
  }

  // TODO: Implement validateCredential.
  //
  // What to do:
  //   Per-field live validation called by the setup wizard between prompts.
  //   For a token, call verifyAuth or an equivalent cheap check. For an
  //   ID field (e.g. publisher ID), format-validate it and, where possible,
  //   confirm it exists via the API.
  //
  // Reference: src/networks/awin/adapter.ts::validateCredential + auth.ts.
  //
  // API behaviour to verify:
  //   - Can a field be validated independently of the other fields?
  //   - For OAuth2: does validating the client ID require the secret?
  //     (Rakuten: yes; defer the per-field validator and re-validate after
  //     the secret step.)
  //
  // Error handling:
  //   Return { ok: false, message, hint } on failure. The wizard surfaces
  //   message + hint to the user; keep both actionable.
  //
  // Return type: Promise<CredentialValidationResult> — see src/shared/types.ts.
  async validateCredential(_field: string, _value: string): Promise<CredentialValidationResult> {
    return { ok: false, message: 'not implemented' };
  }

  // TODO: Implement setupSteps.
  //
  // What to do:
  //   Return the SetupStep[] the wizard walks the user through. Each step
  //   names the env-var (`field`), the verbatim button-name navigation
  //   (`label`, `description`), the type (`text | password | number`), and
  //   ideally `validateOnEntry` for live checking.
  //
  // Reference: src/networks/awin/setup.ts.
  //
  // API behaviour to verify:
  //   - What is the user looking at on the dashboard when they need each
  //     credential? Use verbatim button names — do not paraphrase.
  //   - Can any credential be derived from another? (Awin derives
  //     AWIN_PUBLISHER_ID from the token.) If yes, omit it from setupSteps
  //     and expose it via derivedValues() instead.
  //
  // Return type: SetupStep[] — see src/shared/types.ts.
  setupSteps(): SetupStep[] {
    return [];
  }

  // TODO: Implement derivedValues (OPTIONAL — remove if not used).
  //
  // What to do:
  //   Return DerivedValueResult[] for credentials that can be derived from
  //   already-entered ones. The wizard calls this between prompts and
  //   persists the derived values without asking the user.
  //
  // Reference: src/networks/awin/auth.ts derivedValues pattern — Awin
  // derives AWIN_PUBLISHER_ID from /publishers using AWIN_API_TOKEN.
  //
  // API behaviour to verify:
  //   - Is there a credential the user would otherwise have to find
  //     manually that we can derive via the API?
  //   - Is the derivation deterministic (one value out per token), or does
  //     the API return a list the user must choose from?
  //
  // Return type: Promise<DerivedValueResult[]> — see src/shared/types.ts.
  async derivedValues(): Promise<DerivedValueResult[]> {
    return [];
  }

  // TODO: Implement listBrands (REQUIRED if credentialScope is 'multi-brand',
  // otherwise remove this method).
  //
  // What to do:
  //   For an advertiser-side, multi-brand adapter: enumerate every brand the
  //   configured credential set can address and return a DiscoveredBrand per
  //   row. The setup wizard's brand-discovery sub-flow calls this immediately
  //   after verifyAuth() passes; the operator then picks which brands to
  //   register in brands.json under their own logical slug.
  //
  // API behaviour to verify:
  //   - Which endpoint enumerates the brands / campaigns / accounts the
  //     credential set owns? (Impact: /Accounts; CJ: advertiser id list.)
  //   - Does the network expose an "api enabled" flag per brand? If yes,
  //     surface it via DiscoveredBrand.apiEnabled so the wizard can default
  //     the tick boxes correctly. If no, set it to true for every row.
  //
  // Single-brand adapters: delete this method entirely. The interface marks
  // it optional and only multi-brand adapters need to implement it.
  async listBrands(): Promise<DiscoveredBrand[]> {
    throw new NotImplementedError(
      `${SLUG}.listBrands is required for multi-brand adapters and is not yet implemented.`,
    );
  }

  // TODO: Implement capabilitiesCheck.
  //
  // What to do:
  //   Probe each operation with the minimum viable query (`limit: 1`,
  //   narrow date window). Record latency. Record known-unsupported ops
  //   without probing. Wrap each probe in try/catch — a single failing op
  //   must not block the others.
  //
  // Reference: src/networks/awin/adapter.ts::capabilitiesCheck.
  //
  // Error handling:
  //   A probe that throws records `{ supported: false, note: err.message }`
  //   on the operation entry, not a thrown error from this method.
  //
  // Return type: Promise<NetworkCapabilities> — see src/shared/types.ts.
  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations: {},
      knownLimitations: META.knownLimitations,
    };
  }
}
