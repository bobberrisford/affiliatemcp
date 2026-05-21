/**
 * Template: <NETWORK_NAME> adapter.
 *
 * Copy this folder to `src/networks/<slug>/` and implement each TODO.
 * Chunk 11 enriches these TODO comments with Claude-Code-readable instructions;
 * at v0.1 this is the structural skeleton only.
 */

import type {
  Click,
  ClickQuery,
  CredentialValidationResult,
  DerivedValueResult,
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
} from '../../src/shared/types.js';
import { NotImplementedError } from '../../src/shared/types.js';
import { DEFAULT_RESILIENCE } from '../../src/shared/resilience.js';

// TODO: replace with the real slug.
const SLUG = 'TEMPLATE_NETWORK';

const META: NetworkMeta = {
  slug: SLUG,
  // TODO: human-readable name shown in tool descriptions.
  name: 'TEMPLATE_NETWORK',
  // TODO: production base URL of the network API.
  baseUrl: 'https://api.example.com',
  authModel: 'bearer',
  adapterVersion: '0.0.1',
  claimStatus: 'experimental',
  knownLimitations: [],
  supportsBrandOps: false,
  setupTimeEstimateMinutes: 10,
  setupRequiresApproval: false,
};

export class TemplateNetworkAdapter implements NetworkAdapter {
  readonly slug = SLUG;
  readonly name = META.name;
  readonly meta = META;
  readonly resilienceConfig: ResilienceConfigMap = { default: DEFAULT_RESILIENCE };

  async listProgrammes(_query?: ProgrammeQuery): Promise<Programme[]> {
    // TODO: implement.
    throw new NotImplementedError(`${SLUG}.listProgrammes is not yet implemented.`);
  }
  async getProgramme(_programmeId: string): Promise<Programme> {
    // TODO: implement.
    throw new NotImplementedError(`${SLUG}.getProgramme is not yet implemented.`);
  }
  async listTransactions(_query?: TransactionQuery): Promise<Transaction[]> {
    // TODO: implement.
    throw new NotImplementedError(`${SLUG}.listTransactions is not yet implemented.`);
  }
  async getEarningsSummary(_query?: TransactionQuery): Promise<EarningsSummary> {
    // TODO: implement.
    throw new NotImplementedError(`${SLUG}.getEarningsSummary is not yet implemented.`);
  }
  async listClicks(_query?: ClickQuery): Promise<Click[]> {
    // TODO: implement.
    throw new NotImplementedError(`${SLUG}.listClicks is not yet implemented.`);
  }
  async generateTrackingLink(_input: {
    programmeId: string;
    destinationUrl: string;
  }): Promise<TrackingLink> {
    // TODO: implement.
    throw new NotImplementedError(`${SLUG}.generateTrackingLink is not yet implemented.`);
  }
  async verifyAuth(): Promise<{ ok: true; identity?: string } | { ok: false; reason: string }> {
    // TODO: implement.
    return { ok: false, reason: 'not implemented' };
  }

  async listPublishers(): Promise<never> {
    throw new NotImplementedError('listPublishers is admin-only and not exposed at v0.1.');
  }
  async listPublisherSectors(): Promise<never> {
    throw new NotImplementedError('listPublisherSectors is admin-only and not exposed at v0.1.');
  }

  async validateCredential(_field: string, _value: string): Promise<CredentialValidationResult> {
    // TODO: implement field-specific validation.
    return { ok: false, message: 'not implemented' };
  }

  setupSteps(): SetupStep[] {
    // TODO: enumerate the credentials the wizard should prompt for.
    return [];
  }

  async derivedValues(): Promise<DerivedValueResult[]> {
    // TODO: implement if the network exposes a value derivable from another (e.g. publisherId from an API call).
    return [];
  }

  async capabilitiesCheck(): Promise<NetworkCapabilities> {
    return {
      network: SLUG,
      generatedAt: new Date().toISOString(),
      operations: {},
      knownLimitations: META.knownLimitations,
    };
  }
}
