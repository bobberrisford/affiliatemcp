// The 72 network families shipped as adapters, from the README network table.
export const NETWORKS = [
  '2Performant', 'AccessTrade', 'Adcell', 'Addrevenue', 'Admitad', 'Adrecord',
  'Adservice', 'Adtraction', 'Affilae', 'Affiliate Future', 'Affise', 'Afilio',
  'Amazon Creators', 'AvantLink', 'Awin', 'Belboon', 'CAKE', 'CJ Affiliate',
  'ClickBank', 'Commission Factory', 'Connexity', 'Coupang Partners', 'Daisycon',
  'Digistore24', 'eBay', 'Eduzz', 'Effiliation', 'eHUB', 'Everflow', 'financeAds',
  'FirstPromoter', 'FlexOffers', 'Flipkart', 'GrowSurf', 'Hotmart', 'Howl',
  'Impact', 'Indoleads', 'Involve Asia', 'Kwanko', 'LeadDyno', 'Levanta',
  'LinkConnector', 'Lomadee', 'Monetizze', 'mrge', 'NetRefer', 'Offer18',
  'Optimise Media', 'Partnerize', 'Partnero', 'PartnerStack', 'Pepperjam',
  'Post Affiliate Pro', 'Profitshare', 'Rakuten', 'Refersion', 'Rewardful',
  'Scaleo', 'ShareASale', 'ShopMy', 'Skimlinks', 'Sovrn', 'Tapfiliate', 'Tolt',
  'Tradedoubler', 'TradeTracker', 'Travelpayouts', 'TUNE', 'ValueCommerce',
  'Webgains', 'Yieldkit',
] as const;

// The seven canonical publisher operations every adapter aims to expose.
export const CANONICAL_OPS = [
  'verify_auth',
  'list_programmes',
  'get_programme',
  'list_transactions',
  'get_earnings_summary',
  'list_clicks',
  'generate_tracking_link',
] as const;
