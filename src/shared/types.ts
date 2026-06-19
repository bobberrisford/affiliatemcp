/**
 * affiliate-mcp — shared type contracts.
 *
 * SINGLE SOURCE OF TRUTH. These types are STABLE.
 *
 * Every network adapter, MCP tool handler, and CLI surface must speak in these
 * shapes. If you find yourself reaching for a new field, prefer extending the
 * `rawNetworkData` escape hatch first; only widen the canonical type when a
 * concept is genuinely shared across at least two networks.
 *
 * UK English throughout. The user-visible noun is "programme" (not "program").
 *
 * Mirrors PRD v0.4 §6 / Appendix C.
 */

// ---------------------------------------------------------------------------
// Network metadata + capabilities
// ---------------------------------------------------------------------------

export type NetworkSlug = string;

/**
 * Supported operation names. Tools generated from adapters map 1:1 to these.
 * Two further admin operations (`listPublishers`, `listPublisherSectors`) are
 * defined on `NetworkAdapter` but throw `NotImplementedError` at v0.1.
 */
export type AdapterOperation =
  | 'listProgrammes'
  | 'getProgramme'
  | 'listTransactions'
  | 'getEarningsSummary'
  | 'listClicks'
  | 'generateTrackingLink'
  | 'verifyAuth'
  // Advertiser-side operations. Publisher adapters throw NotImplementedError
  // on these; advertiser adapters implement them. Kept generic so CJ and Awin
  // advertiser adapters (later PRs) reuse the same names.
  | 'listMediaPartners'
  | 'getProgrammePerformance'
  // Advertiser-side contract reads. The payment-term relationship between a
  // brand and a partner. Read-only here; the write surface (proposeContract,
  // applyContract, removeContract) lands in later PRs behind a consent gate.
  // See docs/decisions/2026-06-12-impact-contracts-actions.md.
  | 'listContracts'
  | 'getContract';

export type AdminOperation = 'listPublishers' | 'listPublisherSectors';

export type AnyOperation = AdapterOperation | AdminOperation;

export interface NetworkMeta {
  slug: NetworkSlug;
  name: string;
  baseUrl: string;
  authModel: 'bearer' | 'oauth2' | 'basic' | 'custom';
  docsUrl?: string;
  adapterVersion: string;
  lastVerified?: string; // ISO date
  claimStatus: 'production' | 'partial' | 'experimental' | 'unsupported';
  knownLimitations: string[];
  supportsBrandOps: boolean;
  setupTimeEstimateMinutes: number;
  setupRequiresApproval: boolean;
  setupApprovalDaysTypical?: number;
  /**
   * Which side of the affiliate relationship this adapter integrates with.
   * Inert metadata at this stage — no code path branches on it yet.
   */
  side: 'publisher' | 'advertiser';
  /**
   * Whether a single set of credentials addresses one brand or many.
   * Inert metadata at this stage — no code path branches on it yet.
   */
  credentialScope: 'single-brand' | 'multi-brand';
  /**
   * IANA timezone (e.g. `"Europe/London"`, `"America/New_York"`) a network
   * reports dates in when its API returns naïve timestamps with no explicit
   * offset.
   *
   * Adapter-side parsing contract: when an adapter declares this, it MUST use
   * this zone to interpret naïve upstream timestamps into canonical UTC before
   * emitting them via `toISOString()`. Consumers cannot recover the original
   * instant after the fact — a naïve timestamp parsed in the host timezone is
   * already lossy — so the conversion is the adapter's responsibility, not a
   * hint for consumers to reinterpret returned timestamps.
   *
   * Optional, and during the per-network rollout absence carries no semantic
   * meaning: it may mean the network is offset-qualified (ISO-8601 with `Z` or
   * `±HH:MM`) or that the adapter has not yet been migrated. Consumers must not
   * infer offset-qualification from absence until rollout is complete.
   */
  networkTimezone?: string;
}

export interface OperationCapability {
  supported: boolean;
  latencyMs?: number;
  sampleSize?: number;
  note?: string;
  /**
   * Optional per-operation claim status. Overrides the network-level
   * `meta.claimStatus` for THIS operation only. When absent, consumers
   * (doctor surface, list-networks meta tool, diagnostic meta tool) fall
   * back to the adapter's `meta.claimStatus`.
   *
   * Use this to flag operations that are less verified than the rest of
   * the adapter — e.g. an op whose endpoint shape carries `// TODO(verify)`
   * annotations against a live tenant, or a synthesised/derived view whose
   * upstream payloads have not been confirmed.
   *
   * Strictly additive at v0.1: every existing capabilities consumer treats
   * the absence of this field the same as before this field existed.
   */
  claimStatus?: 'production' | 'partial' | 'experimental';
}

export interface NetworkCapabilities {
  network: NetworkSlug;
  generatedAt: string; // ISO timestamp
  operations: Record<string, OperationCapability>;
  knownLimitations: string[];
}

// ---------------------------------------------------------------------------
// Domain types — programmes, transactions, clicks, links, earnings
// ---------------------------------------------------------------------------

export type ProgrammeStatus =
  | 'joined'
  | 'pending'
  | 'declined'
  | 'available'
  | 'suspended'
  | 'unknown';

/**
 * A merchant programme the publisher has joined (or could join).
 *
 * `commissionRate` is intentionally permissive: networks vary wildly
 * (flat percent, tiered, per-product). Adapters set whichever is closest;
 * verbatim source lives in `rawNetworkData`.
 */
export interface Programme {
  id: string;
  name: string;
  slug?: string;
  network: NetworkSlug;
  status: ProgrammeStatus;
  currency?: string;
  commissionRate?: string | CommissionRateStructured;
  categories?: string[];
  advertiserUrl?: string;
  /**
   * Stable cross-network identity for the underlying merchant.
   *
   * When populated, consumers can group "Acme on Awin" with "Acme on CJ"
   * without string-matching display names. Populated by the brand-resolver
   * (see PR follow-up) from the `advertiserUrl` eTLD+1, the resolver's
   * configured aliases, or a slugified `name` fallback.
   *
   * Optional in this PR; adapters begin populating in the per-network
   * normalisation rollout. Absent means the consumer should not assume
   * cross-network identity.
   */
  merchantKey?: string;
  /**
   * Provenance of `merchantKey`. Lets consumers weight matches —
   * a `resolver`-sourced key is a confident identity; `fallback-name`
   * is best-effort.
   */
  merchantKeySource?: 'resolver' | 'fallback-domain' | 'fallback-name' | 'none';
  rawNetworkData: unknown;
}

export interface CommissionRateStructured {
  type: 'percent' | 'flat' | 'tiered' | 'mixed' | 'unknown';
  /** Percent (0–100) for `percent`; absolute amount for `flat`. */
  value?: number;
  currency?: string;
  description?: string;
  tiers?: Array<{ label?: string; value: number; currency?: string; description?: string }>;
}

export type TransactionStatus = 'pending' | 'approved' | 'reversed' | 'paid' | 'other';

export interface Transaction {
  id: string;
  network: NetworkSlug;
  programmeId: string;
  programmeName: string;
  status: TransactionStatus;
  /**
   * Verbatim upstream status token before mapping to the canonical
   * `TransactionStatus` enum (e.g. Awin `"approved"`, Impact `"LOCKED"`,
   * Tradedoubler `"A"`).
   *
   * Lets consumers distinguish rows that collapsed into `status: 'other'`
   * and re-classify if their use case needs a finer split (Impact `LOCKED`
   * is approved-and-irreversible; the canonical enum currently lumps it
   * under `other`).
   *
   * Optional in this PR; adapters begin populating in the per-network
   * normalisation rollout (Awin reference adapter first). Consumers must
   * fall back to `status` when absent.
   */
  statusRaw?: string;
  amount: number;
  currency: string;
  commission: number;
  dateClicked?: string; // ISO
  dateConverted: string; // ISO
  dateApproved?: string; // ISO
  datePaid?: string; // ISO
  /** Derived: age of the transaction in days at the point the adapter responded. */
  ageDays: number;
  reversalReason?: string;
  /**
   * Stable cross-network identity for the merchant this transaction
   * belongs to. Inherited from the parent `Programme.merchantKey` at the
   * tool layer; see `Programme.merchantKey` for semantics and provenance.
   */
  merchantKey?: string;
  rawNetworkData: unknown;
}

export interface Click {
  id: string;
  network: NetworkSlug;
  programmeId?: string;
  timestamp: string; // ISO
  referrer?: string;
  destinationUrl?: string;
  rawNetworkData: unknown;
}

export interface TrackingLink {
  network: NetworkSlug;
  destinationUrl: string;
  trackingUrl: string;
  programmeId?: string;
  createdAt: string; // ISO
  rawNetworkData: unknown;
}

export interface EarningsByProgramme {
  programmeId: string;
  programmeName: string;
  total: number;
  currency: string;
  transactionCount: number;
}

export interface EarningsByStatus {
  pending: number;
  approved: number;
  reversed: number;
  paid: number;
  other: number;
  currency: string;
}

export interface EarningsSummary {
  network: NetworkSlug;
  totalEarnings: number;
  currency: string;
  byProgramme: EarningsByProgramme[];
  byStatus: EarningsByStatus;
  /** Useful for principle 4.1: "the £42 from January is still pending after 95 days". */
  oldestUnpaidAgeDays?: number;
  periodFrom: string; // ISO
  periodTo: string; // ISO
}

// ---------------------------------------------------------------------------
// Advertiser-side domain types
// ---------------------------------------------------------------------------

/**
 * A publisher (a.k.a. media partner / affiliate) running on a brand's
 * programme — surfaced by advertiser-side adapters via `listMediaPartners`.
 *
 * The shape is deliberately generic across networks: Impact calls these
 * `MediaPartners`, CJ uses `Publishers`, Awin uses `Publishers` too.
 * `status` is the canonical normalised state; the verbatim upstream payload
 * lives on `rawNetworkData` so the operator can drill in.
 */
export interface MediaPartner {
  id: string;
  name: string;
  status: 'active' | 'pending' | 'inactive' | 'unknown';
  rawNetworkData: unknown;
}

/**
 * One row of the unified per-publisher / per-period performance report.
 *
 * Networks vary wildly in which fields they actually populate. Convention:
 *  - missing numeric fields use `0` (never invent values upstream did not
 *    provide; the user can disambiguate via `rawNetworkData`).
 *  - missing string statuses fall back to `'pending'` only when the upstream
 *    semantically means "not yet approved"; otherwise leave the raw value on
 *    `rawNetworkData` and pick the closest of the three canonical states.
 */
export interface ProgrammePerformanceRow {
  /** ISO `YYYY-MM-DD` (or `YYYY-MM` if the network only reports monthly). */
  date: string;
  publisherId: string;
  publisherName: string;
  clicks: number;
  conversions: number;
  /** Gross sale amount, in `currency`. */
  grossSale: number;
  /** Commission paid to the publisher, in `currency`. */
  commission: number;
  currency: string;
  status: 'pending' | 'approved' | 'reversed';
  rawNetworkData: unknown;
}

/**
 * A contract: the payment-term relationship between a brand and a media
 * partner on a programme — surfaced by advertiser-side adapters via
 * `listContracts` / `getContract`.
 *
 * This is the read shape. The write surface that proposes and applies changes
 * to a contract (`proposeContract`, `applyContract`, `removeContract`) is
 * defined in a later PR behind a consent gate; see
 * docs/decisions/2026-06-12-impact-contracts-actions.md.
 *
 * Networks vary in how much of a contract they expose. `status` is the
 * canonical normalised state; the verbatim upstream payload (rate cards,
 * tiers, term dates) lives on `rawNetworkData` so the operator can drill in.
 */
export interface Contract {
  id: string;
  network: NetworkSlug;
  /** The programme/campaign this contract governs (Impact: CampaignId). */
  programmeId: string;
  programmeName?: string;
  /** The media partner/publisher the contract is with, when scoped to one. */
  mediaPartnerId?: string;
  mediaPartnerName?: string;
  /** Canonical lifecycle state of the contract. */
  status: 'active' | 'pending' | 'expired' | 'inactive' | 'unknown';
  /** Human-readable summary of the payout terms, when the network provides one. */
  payoutTerms?: string;
  effectiveDate?: string; // ISO
  expiryDate?: string; // ISO
  rawNetworkData: unknown;
}

// ---------------------------------------------------------------------------
// Query shapes — passed to adapter ops
// ---------------------------------------------------------------------------

export interface ProgrammeQuery {
  status?: ProgrammeStatus | ProgrammeStatus[];
  search?: string;
  categories?: string[];
  limit?: number;
  cursor?: string;
}

export interface TransactionQuery {
  programmeId?: string;
  status?: TransactionStatus | TransactionStatus[];
  /** ISO date — start of conversion window. */
  from?: string;
  /** ISO date — end of conversion window. */
  to?: string;
  /** Minimum transaction age in days (computed against `dateConverted`). */
  minAgeDays?: number;
  /** Maximum transaction age in days. */
  maxAgeDays?: number;
  limit?: number;
  cursor?: string;
}

export interface ClickQuery {
  programmeId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface MediaPartnerQuery {
  status?: MediaPartner['status'] | Array<MediaPartner['status']>;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface ProgrammePerformanceQuery {
  from?: string;
  to?: string;
  /** Optional: scope to a single programme/campaign id on the brand. */
  programmeId?: string;
  /** Optional: scope to a single publisher/media-partner id. */
  publisherId?: string;
  limit?: number;
  cursor?: string;
}

export interface ContractQuery {
  /**
   * The programme/campaign whose contracts to list. Impact addresses
   * contracts under a campaign (`/Campaigns/{id}/Contracts`), so adapters
   * that need it require this at runtime and throw a `config_error` envelope
   * when it is absent.
   */
  programmeId?: string;
  status?: Contract['status'] | Array<Contract['status']>;
  /** Optional: scope to a single media-partner/publisher id. */
  mediaPartnerId?: string;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Adapter call context (advertiser-side)
// ---------------------------------------------------------------------------

/**
 * Per-call context threaded through from the tool dispatcher into advertiser-
 * side adapter methods after `resolveBrandForNetwork` has translated the
 * caller-supplied `brand` slug into a `networkBrandId`.
 *
 * Publisher adapter methods do not receive a context (they address a single
 * publisher account from credentials in env). Advertiser adapter methods take
 * this as an optional second argument — optional at the type level so the
 * cross-cutting `NetworkAdapter` interface remains backward-compatible with
 * the five existing publisher adapters. Advertiser implementations are
 * expected to require it at runtime.
 */
export interface AdapterCallContext {
  /**
   * The network's own brand identifier (e.g. an Impact Advertiser SID, a CJ
   * advertiser id). Resolved from `(brand, network)` via brand-resolver and
   * passed verbatim to the adapter so the adapter can address the right
   * brand under multi-brand credentials.
   */
  networkBrandId: string;
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Every adapter failure must round-trip through this shape. Principle 4.1:
 * name the network, name the operation, surface the verbatim network body,
 * never invent success.
 */
export interface NetworkErrorEnvelope {
  type:
    | 'auth_error'
    | 'rate_limit'
    | 'network_api_error'
    | 'network_unavailable'
    | 'not_implemented'
    | 'config_error'
    | 'timeout'
    | 'circuit_open';
  network: NetworkSlug;
  operation: string;
  httpStatus?: number;
  /** Verbatim body returned by the network. Redaction happens at the logger, not here. */
  networkErrorBody?: string;
  message: string;
  hint?: string;
  timestamp: string; // ISO
}

/**
 * Thrown by operations that an adapter does not (yet) support.
 * Surfaces as a `not_implemented` envelope; never silently empty.
 */
export class NotImplementedError extends Error {
  public readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'NotImplementedError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Setup + credential validation
// ---------------------------------------------------------------------------

export interface SetupStep {
  field: string;
  label: string;
  description: string;
  type: 'text' | 'password' | 'number';
  example?: string;
  /** If present, called by the wizard before persisting. */
  validateOnEntry?: (value: string) => Promise<CredentialValidationResult> | CredentialValidationResult;
}

export interface CredentialValidationResult {
  ok: boolean;
  message?: string;
  hint?: string;
}

export interface DerivedValueResult {
  field: string;
  value: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Resilience config — per operation
// ---------------------------------------------------------------------------

export interface ResilienceConfig {
  timeoutMs: number;
  retries: number;
  /** HTTP status codes that warrant a retry. By policy: never include 4xx except 429. */
  retryOn: number[];
  circuitBreaker: {
    threshold: number;
    cooldownMs: number;
  };
}

export type ResilienceConfigMap = Partial<Record<AnyOperation, ResilienceConfig>> & {
  default: ResilienceConfig;
};

// ---------------------------------------------------------------------------
// NetworkAdapter — the contract every network must implement
// ---------------------------------------------------------------------------

export interface NetworkAdapter {
  readonly slug: NetworkSlug;
  readonly name: string;
  readonly meta: NetworkMeta;
  readonly resilienceConfig: ResilienceConfigMap;

  // Publisher / shared ops — the seven canonical operations.
  //
  // Each accepts an optional `ctx?: AdapterCallContext`. Publisher adapters
  // ignore it (they read credentials from env and address a single account).
  // Advertiser adapters use `ctx.networkBrandId` to address the right brand
  // under multi-brand credentials — that ctx is required at runtime for those
  // adapters, but the interface marks it optional so this cross-cutting
  // contract does not break any existing publisher adapter signature.
  listProgrammes(query?: ProgrammeQuery, ctx?: AdapterCallContext): Promise<Programme[]>;
  getProgramme(programmeId: string, ctx?: AdapterCallContext): Promise<Programme>;
  listTransactions(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<Transaction[]>;
  getEarningsSummary(query?: TransactionQuery, ctx?: AdapterCallContext): Promise<EarningsSummary>;
  listClicks(query?: ClickQuery, ctx?: AdapterCallContext): Promise<Click[]>;
  generateTrackingLink(
    input: { programmeId: string; destinationUrl: string },
    ctx?: AdapterCallContext,
  ): Promise<TrackingLink>;
  verifyAuth(
    ctx?: AdapterCallContext,
  ): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }>;

  // Admin ops — throw NotImplementedError at v0.1.
  listPublishers(): Promise<never>;
  listPublisherSectors(): Promise<never>;

  // Advertiser-side ops. Optional on the interface (publisher adapters do not
  // implement them); the tool generator only wires these for advertiser-side
  // adapters, and the chassis throws NotImplementedError if an advertiser
  // adapter forgets to override them (see `defaultAdvertiserMethods`).
  listMediaPartners?(
    query?: MediaPartnerQuery,
    ctx?: AdapterCallContext,
  ): Promise<MediaPartner[]>;
  getProgrammePerformance?(
    query?: ProgrammePerformanceQuery,
    ctx?: AdapterCallContext,
  ): Promise<ProgrammePerformanceRow[]>;

  // Advertiser-side contract reads. Optional, same pattern as the two ops
  // above: the tool generator wires them for advertiser-side adapters only,
  // and the invoke guard throws NotImplementedError if an advertiser adapter
  // does not override them. The write surface is added in later PRs.
  listContracts?(query?: ContractQuery, ctx?: AdapterCallContext): Promise<Contract[]>;
  getContract?(
    input: { programmeId: string; contractId: string },
    ctx?: AdapterCallContext,
  ): Promise<Contract>;

  // Setup + diagnostics
  validateCredential(field: string, value: string): Promise<CredentialValidationResult>;
  setupSteps(): SetupStep[];
  derivedValues?(): Promise<DerivedValueResult[]>;
  capabilitiesCheck(): Promise<NetworkCapabilities>;

  /**
   * List the brands addressable by this adapter's configured credentials.
   *
   * Required at runtime for adapters whose `meta.credentialScope === 'multi-brand'` —
   * the brand-discovery sub-flow in the setup wizard calls this after auth has
   * been verified. Optional and unused for `single-brand` adapters.
   */
  listBrands?(): Promise<DiscoveredBrand[]>;
}

/**
 * A brand discovered via an advertiser-side adapter's `listBrands()` method.
 *
 * `networkBrandId` is the network's own identifier for the brand (e.g. Impact
 * `CampaignId`, CJ advertiser id). `apiEnabled` is `false` for brands the
 * credential set knows about but cannot transact against (paused, in-onboarding).
 */
export interface DiscoveredBrand {
  networkBrandId: string;
  displayName: string;
  apiEnabled: boolean;
}

// ---------------------------------------------------------------------------
// brands.json — agency-side mapping of logical brand slugs to network identifiers
// ---------------------------------------------------------------------------

/**
 * One entry binds a logical brand (`acme`) to a (network, credentialId,
 * networkBrandId) tuple. The same logical brand can appear under several
 * networks; that is how cross-network rollups are produced.
 */
export interface BrandBinding {
  network: NetworkSlug;
  credentialId: string;
  networkBrandId: string;
}

/**
 * The shape of `~/.affiliate-mcp/brands.json`. Owned by the wizard but readable
 * by the MCP server at request-dispatch time.
 */
export interface BrandsFile {
  version: 1;
  brands: Record<string, BrandBinding[]>;
}

// ---------------------------------------------------------------------------
// clients/<slug>/ — per-client advisory strategy and KPI files
// ---------------------------------------------------------------------------
// See docs/decisions/2026-06-12-client-strategy-recording.md and the grammar
// addendum docs/decisions/2026-06-16-client-strategy-kpi-grammar-and-tools.md.
// These files are advisory context for reporting; they never authorise a
// network write.

/** Comparator in a KPI target line. */
export type KpiComparator = '>=' | '<=' | '>' | '<' | '=';

/**
 * Known KPI metrics. Closed enum: an unrecognised metric is a parse error, never
 * a guess. `revenue`/`commission` are monetary; `epc`/`aov` are monetary
 * per-unit; `reversal_rate`/`approval_rate` are percentages; `conversions` is a
 * count.
 */
export type KpiMetric =
  | 'revenue'
  | 'conversions'
  | 'commission'
  | 'epc'
  | 'aov'
  | 'reversal_rate'
  | 'approval_rate';

/** Period a target is measured over. */
export type KpiPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * One parsed target from the fenced `kpi` block:
 * `metric: comparator value [unit] [per period]`.
 * `unit` is a currency code for monetary metrics, `%` for rate metrics, or
 * undefined when omitted. `period` is undefined when the line names no period.
 */
export interface KpiTarget {
  metric: KpiMetric;
  comparator: KpiComparator;
  value: number;
  unit?: string;
  period?: KpiPeriod;
}

/**
 * A line the parser could not accept. Carries the verbatim source line and a
 * human-readable reason. Parse errors are reported and excluded from verdicts;
 * the reader never guesses a malformed line's meaning.
 */
export interface KpiParseError {
  line: number;
  text: string;
  reason: string;
}

/** Result of parsing the fenced `kpi` block in a `KPI.md` file. */
export interface KpiParseResult {
  /** Present when a `version:` marker was found and recognised. */
  version?: number;
  targets: KpiTarget[];
  errors: KpiParseError[];
}

/** A single client-strategy markdown file (`Strategy.md` or `KPI.md`). */
export interface ClientStrategyFile {
  present: boolean;
  markdown?: string;
}

/**
 * The advisory strategy context for one client, keyed by the brand slug from
 * `brands.json`. `orphan` is true when a `clients/<slug>/` directory exists but
 * the slug has no brand binding. Missing files are normal, not an error.
 */
export interface ClientStrategy {
  brand: string;
  orphan: boolean;
  strategy: ClientStrategyFile;
  kpi: ClientStrategyFile & { parsed?: KpiParseResult };
}
