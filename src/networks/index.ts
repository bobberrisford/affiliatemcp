/**
 * Network adapter aggregator.
 *
 * The single import point that triggers each adapter's `registerAdapter`
 * side effect. The MCP server and any tooling that wants the registry
 * populated should import this module.
 *
 * Adding a new network is intentionally one line: import its adapter file.
 * The act of importing causes the file's top-level `registerAdapter` call
 * to run, registering the adapter with the shared registry.
 *
 * If you want to programmatically enable / disable networks at runtime,
 * do NOT do it here — add a feature flag in the import path of whichever
 * entry consumes the registry. This file's job is to BE the list.
 */

import './2performant/adapter.js';
import './accesstrade/adapter.js';
import './addrevenue/adapter.js';
import './admitad/adapter.js';
import './admitad-advertiser/adapter.js';
import './adrecord/adapter.js';
import './adservice/adapter.js';
import './adtraction/adapter.js';
import './adtraction-advertiser/adapter.js';
import './affilae/adapter.js';
import './affiliate-future/adapter.js';
import './affise/adapter.js';
import './afilio/adapter.js';
import './avantlink/adapter.js';
import './awin/adapter.js';
import './awin-advertiser/adapter.js';
import './cake/adapter.js';
import './cj/adapter.js';
import './cj-advertiser/adapter.js';
import './clickbank/adapter.js';
import './commission-factory/adapter.js';
import './commission-factory-advertiser/adapter.js';
import './connexity/adapter.js';
import './coupang-partners/adapter.js';
import './daisycon/adapter.js';
import './daisycon-advertiser/adapter.js';
import './digistore24/adapter.js';
import './ebay/adapter.js';
import './eduzz/adapter.js';
import './effiliation/adapter.js';
import './ehub/adapter.js';
import './everflow/adapter.js';
import './everflow-advertiser/adapter.js';
import './firstpromoter/adapter.js';
import './flexoffers/adapter.js';
import './flipkart/adapter.js';
import './growsurf/adapter.js';
import './hotmart/adapter.js';
import './howl/adapter.js';
import './impact/adapter.js';
import './impact-advertiser/adapter.js';
import './indoleads/adapter.js';
import './involve-asia/adapter.js';
import './kwanko/adapter.js';
import './kwanko-advertiser/adapter.js';
import './leaddyno/adapter.js';
import './levanta/adapter.js';
import './linkconnector/adapter.js';
import './lomadee/adapter.js';
import './monetizze/adapter.js';
import './mrge/adapter.js';
import './netrefer/adapter.js';
import './offer18/adapter.js';
import './optimise-media/adapter.js';
import './partnerize/adapter.js';
import './partnerize-advertiser/adapter.js';
import './partnero/adapter.js';
import './partnerstack/adapter.js';
import './partnerstack-advertiser/adapter.js';
import './pepperjam/adapter.js';
import './post-affiliate-pro/adapter.js';
import './profitshare/adapter.js';
import './rakuten/adapter.js';
import './refersion/adapter.js';
import './rewardful/adapter.js';
import './scaleo/adapter.js';
import './shareasale/adapter.js';
import './shopmy/adapter.js';
import './skimlinks/adapter.js';
import './sovrn-commerce/adapter.js';
import './tapfiliate/adapter.js';
import './tolt/adapter.js';
import './tradedoubler/adapter.js';
import './tradedoubler-advertiser/adapter.js';
import './travelpayouts/adapter.js';
import './tune/adapter.js';
import './value-commerce/adapter.js';
import './value-commerce-advertiser/adapter.js';
import './webgains/adapter.js';
import './webgains-advertiser/adapter.js';
import './yieldkit/adapter.js';
