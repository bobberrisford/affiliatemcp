import { awinRequest } from '../client.js';
import { DEFAULT_RESILIENCE } from '../../../shared/resilience.js';
import {
  AWIN_SLUG,
  requirePositiveIntegerId,
  requirePublisherId,
  requireToken,
  toQuery,
} from './shared.js';

export type AwinProgrammeRelationship =
  | 'joined'
  | 'pending'
  | 'suspended'
  | 'rejected'
  | 'notjoined'
  | 'any';

export interface AwinProgrammeDetailsInput {
  advertiserId: string | number;
  relationship?: AwinProgrammeRelationship;
}

export interface AwinCommissionGroupsInput {
  advertiserId: string | number;
  effectiveDate?: string;
  extraConditionsDetails?: boolean;
}

export interface AwinProgrammeDetailsResult {
  network: 'awin';
  publisherId: string;
  advertiserId: string;
  programmeInfo: unknown;
  kpi: unknown;
  commissionRange: unknown;
  rawNetworkData: unknown;
}

export interface AwinCommissionGroupsResult {
  network: 'awin';
  publisherId: string;
  advertiserId: string;
  commissionGroups: unknown[];
  rawNetworkData: unknown;
}

export interface AwinCommissionSharingRulesResult {
  network: 'awin';
  publisherId: string;
  rules: unknown[];
  rawNetworkData: unknown;
}

export async function getProgrammeDetails(
  input: AwinProgrammeDetailsInput,
): Promise<AwinProgrammeDetailsResult> {
  const operation = 'getProgrammeDetails';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  const advertiserId = requirePositiveIntegerId(input.advertiserId, 'advertiserId', operation);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/programmedetails`,
    token,
    query: toQuery({
      advertiserId,
      relationship: input.relationship ?? 'joined',
    }),
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    network: AWIN_SLUG,
    publisherId,
    advertiserId,
    programmeInfo: record['programmeInfo'] ?? raw,
    kpi: record['kpi'],
    commissionRange: record['commissionRange'],
    rawNetworkData: raw,
  };
}

export async function listCommissionGroups(
  input: AwinCommissionGroupsInput,
): Promise<AwinCommissionGroupsResult> {
  const operation = 'listCommissionGroups';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);
  const advertiserId = requirePositiveIntegerId(input.advertiserId, 'advertiserId', operation);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/commissiongroups`,
    token,
    query: toQuery({
      advertiserId,
      effectiveDate: input.effectiveDate,
      extraConditionsDetails: input.extraConditionsDetails,
    }),
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const groups = Array.isArray(record['commissionGroups']) ? record['commissionGroups'] : [];
  return {
    network: AWIN_SLUG,
    publisherId,
    advertiserId,
    commissionGroups: groups,
    rawNetworkData: raw,
  };
}

export async function listCommissionSharingRules(): Promise<AwinCommissionSharingRulesResult> {
  const operation = 'listCommissionSharingRules';
  const publisherId = requirePublisherId(operation);
  const token = requireToken(operation);

  const raw = await awinRequest<unknown>({
    operation,
    path: `/publishers/${publisherId}/commissionsharingrules`,
    token,
    resilience: DEFAULT_RESILIENCE,
  });

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rules = Array.isArray(raw)
    ? raw
    : Array.isArray(record['rules'])
      ? record['rules']
      : Array.isArray(record['commissionSharingRules'])
        ? record['commissionSharingRules']
        : [];
  return {
    network: AWIN_SLUG,
    publisherId,
    rules,
    rawNetworkData: raw,
  };
}
