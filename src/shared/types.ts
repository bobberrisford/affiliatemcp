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
  | 'verifyAuth';

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
}

export interface OperationCapability {
  supported: boolean;
  latencyMs?: number;
  sampleSize?: number;
  note?: string;
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

  // Publisher ops — the seven canonical operations.
  listProgrammes(query?: ProgrammeQuery): Promise<Programme[]>;
  getProgramme(programmeId: string): Promise<Programme>;
  listTransactions(query?: TransactionQuery): Promise<Transaction[]>;
  getEarningsSummary(query?: TransactionQuery): Promise<EarningsSummary>;
  listClicks(query?: ClickQuery): Promise<Click[]>;
  generateTrackingLink(input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink>;
  verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }>;

  // Admin ops — throw NotImplementedError at v0.1.
  listPublishers(): Promise<never>;
  listPublisherSectors(): Promise<never>;

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
