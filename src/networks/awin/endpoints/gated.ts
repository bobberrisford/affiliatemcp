import { AWIN_SLUG, requirePublisherId } from './shared.js';

export interface AwinActionableStub {
  ok: false;
  network: 'awin';
  operation: string;
  status: 'requires_feed_api_key' | 'activation_required' | 'not_implemented';
  message: string;
  requiredCredentials?: string[];
  requiredActivation?: string[];
  endpoint?: string;
  docsUrl: string;
  nextSteps: string[];
}

export interface AwinProductFeedListInput {
  feedApiKeyConfigured?: boolean;
}

export interface AwinProductFeedDownloadInput {
  advertiserId?: string | number;
  vertical?: string;
  locale?: string;
  format?: 'legacy' | 'google-jsonl';
}

export interface AwinProofOfPurchaseInput {
  advertiserId?: string | number;
  dryRun?: boolean;
}

export function listProductFeeds(_input: AwinProductFeedListInput = {}): AwinActionableStub {
  return {
    ok: false,
    network: AWIN_SLUG,
    operation: 'listProductFeeds',
    status: 'requires_feed_api_key',
    message:
      'Awin product feed list download uses a separate feed API key, not the publisher API bearer token.',
    requiredCredentials: ['AWIN_PRODUCT_FEED_API_KEY'],
    endpoint: 'https://productdata.awin.com/datafeed/list/apikey/{AWIN_PRODUCT_FEED_API_KEY}',
    docsUrl: 'https://help.awin.com/developers/docs/product-feed-list-download',
    nextSteps: [
      'Create or copy the feed download API key from Awin Toolbox -> Create-a-Feed.',
      'Store it locally as AWIN_PRODUCT_FEED_API_KEY before enabling live product feed tools.',
      'Keep downloads out of default MCP calls because feed files can be very large.',
    ],
  };
}

export function downloadProductFeed(
  input: AwinProductFeedDownloadInput = {},
): AwinActionableStub {
  const publisherId = safePublisherId();
  const vertical = input.vertical ?? 'retail';
  const locale = input.locale ?? 'en_GB';
  const advertiser = input.advertiserId ?? '{advertiserId}';
  return {
    ok: false,
    network: AWIN_SLUG,
    operation: 'downloadProductFeed',
    status: 'requires_feed_api_key',
    message:
      'Awin product feed downloads are inventoried but not executed in this PR; they need separate feed credentials and large-file handling.',
    requiredCredentials: ['AWIN_PRODUCT_FEED_API_KEY'],
    endpoint:
      input.format === 'google-jsonl'
        ? `/publishers/${publisherId}/awinfeeds/download/${advertiser}-${vertical}-${locale}.jsonl`
        : 'https://productdata.awin.com/datafeed/download/apikey/{AWIN_PRODUCT_FEED_API_KEY}/fid/{feedId}/...',
    docsUrl: 'https://help.awin.com/apidocs/retail-publisher-productapidocumentation-1',
    nextSteps: [
      'Add credential support for AWIN_PRODUCT_FEED_API_KEY.',
      'Stream large CSV/JSONL responses to a user-selected file or resource rather than returning them in a tool payload.',
      'Add live tests that validate headers and first records without downloading entire feeds.',
    ],
  };
}

export function submitProofOfPurchaseTransaction(
  input: AwinProofOfPurchaseInput = {},
): AwinActionableStub {
  const publisherId = safePublisherId();
  const advertiser = input.advertiserId ?? '{advertiserId}';
  return {
    ok: false,
    network: AWIN_SLUG,
    operation: 'submitProofOfPurchaseTransaction',
    status: 'activation_required',
    message:
      'Proof of Purchase is public but write-capable and activation-gated, so this repo does not submit live orders by default.',
    requiredCredentials: ['AWIN_PROOF_OF_PURCHASE_API_KEY'],
    requiredActivation: [
      'Awin Partner Development must enable Proof of Purchase for the publisher.',
      'The advertiser must enable the CLO endpoint for this publisher.',
    ],
    endpoint: `/publishers/${publisherId}/advertiser/${advertiser}/orders`,
    docsUrl: 'https://help.awin.com/apidocs/proof-of-purchase-publisher-transaction-api',
    nextSteps: [
      'Confirm publisher and advertiser activation in Awin.',
      'Add AWIN_PROOF_OF_PURCHASE_API_KEY locally; it is sent as x-api-key, not as the bearer token.',
      input.dryRun === false
        ? 'Keep dryRun enabled until a maintainer explicitly approves live write testing.'
        : 'Design a dry-run validator before any live write implementation.',
    ],
  };
}

function safePublisherId(): string {
  try {
    return requirePublisherId('gatedStub');
  } catch {
    return '{publisherId}';
  }
}
