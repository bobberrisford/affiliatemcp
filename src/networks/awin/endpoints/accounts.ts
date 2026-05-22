import { awinRequest } from '../client.js';
import { DEFAULT_RESILIENCE } from '../../../shared/resilience.js';
import { AWIN_SLUG, requireToken } from './shared.js';

export type AwinAccountType = 'publisher' | 'advertiser' | 'all';

export interface AwinAccountRaw {
  accountId?: number;
  accountName?: string;
  accountType?: string;
  userRole?: string;
  publisherId?: number;
  id?: number;
  name?: string;
}

interface AwinAccountsEnvelope {
  userId?: number;
  accounts?: AwinAccountRaw[];
}

export interface AwinAccount {
  id: string;
  name?: string;
  type?: string;
  userRole?: string;
  rawNetworkData: AwinAccountRaw;
}

export interface AwinAccountsResult {
  network: 'awin';
  accountType: AwinAccountType;
  userId?: number;
  accounts: AwinAccount[];
  rawNetworkData: unknown;
}

export async function listAccounts(
  accountType: AwinAccountType = 'publisher',
): Promise<AwinAccountsResult> {
  const token = requireToken('listAccounts');
  const response = await awinRequest<AwinAccountsEnvelope | AwinAccountRaw[]>({
    operation: 'listAccounts',
    path: '/accounts',
    token,
    query: accountType === 'all' ? undefined : { type: accountType },
    resilience: DEFAULT_RESILIENCE,
  });

  const rawAccounts = normaliseAccountsResponse(response);
  const accounts = rawAccounts
    .filter((account) => accountType === 'all' || account.accountType === accountType)
    .map(toAccount);

  return {
    network: AWIN_SLUG,
    accountType,
    userId: Array.isArray(response) ? undefined : response.userId,
    accounts,
    rawNetworkData: response,
  };
}

export function normaliseAccountsResponse(
  response: AwinAccountsEnvelope | AwinAccountRaw[],
): AwinAccountRaw[] {
  if (Array.isArray(response)) return response;
  return Array.isArray(response.accounts) ? response.accounts : [];
}

function toAccount(raw: AwinAccountRaw): AwinAccount {
  const id = raw.accountId ?? raw.publisherId ?? raw.id;
  const name = raw.accountName ?? raw.name;
  return {
    id: id !== undefined ? String(id) : '',
    name,
    type: raw.accountType,
    userRole: raw.userRole,
    rawNetworkData: raw,
  };
}
