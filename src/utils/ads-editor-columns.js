/**
 * Ads Editor Columns — shared constants for Google Ads Editor CSV format.
 *
 * Called by: services/csv-exporter.js, (future) public/builder.html
 *
 * The 176-column array matches Google Ads Editor's import/export format.
 * Match type normalization handles the API↔CSV enum difference.
 */

/**
 * All 176 columns in Google Ads Editor CSV format, in order.
 * @type {string[]}
 */
const COLS = [
  'Campaign','Labels','Campaign Type','Networks','Budget name','Budget','Budget type',
  'EU political ads','Standard conversion goals','Customer acquisition','Languages',
  'Bid Strategy Type','Bid Strategy Name','Enhanced CPC','Target ROAS','Start Date','End Date',
  'Broad match keywords','Ad Schedule','Ad rotation','Content exclusions',
  'Targeting method','Exclusion method','Google Merchant Center feed','Merchant Identifier',
  'Country of Sale','Feed label','Campaign Priority','Local Inventory Ads',
  'Shopping ads on excluded brands','Inventory filter','Audience targeting','Flexible Reach',
  'AI Max','Text customization','Final URL expansion','Image enhancement','Image generation',
  'Landing page images','Video enhancement','Brand guidelines',
  'Ad Group','Max CPC','Max CPM','Target CPA','Max CPV','Target CPV','Percent CPC',
  'Target CPM','Target CPC','Desktop Bid Modifier','Mobile Bid Modifier','Tablet Bid Modifier',
  'TV Screen Bid Modifier','Display Network Custom Bid Type','Optimized targeting',
  'Strict age and gender targeting','Search term matching','Ad Group Type','Channels',
  'Audience name','Age demographic','Gender demographic','Income demographic',
  'Parental status demographic','Remarketing audience segments','Interest categories',
  'Life events','Custom audience segments','Detailed demographics',
  'Remarketing audience exclusions','Tracking template','Final URL suffix','Custom parameters',
  'Asset Group',
  'Headline 1','Headline 2','Headline 3','Headline 4','Headline 5',
  'Headline 6','Headline 7','Headline 8','Headline 9','Headline 10',
  'Headline 11','Headline 12','Headline 13','Headline 14','Headline 15',
  'Long headline 1','Long headline 2','Long headline 3','Long headline 4','Long headline 5',
  'Description 1','Description 2','Description 3','Description 4','Description 5',
  'Call to action','Business name',
  'Video ID 1','Video ID 2','Video ID 3','Video ID 4','Video ID 5',
  'Path 1','Path 2','Final URL','Final mobile URL','Audience signal',
  'ID','Location','Reach','Location groups','Radius','Unit','Bid Modifier',
  'Account keyword type','Keyword','Criterion Type',
  'First page bid','Top of page bid','First position bid',
  'Quality score','Landing page experience','Expected CTR','Ad relevance',
  'Product Group','Product Group Type',
  'Label','Color','Description','Ad type',
  'Headline 1 position','Headline 2 position','Headline 3 position',
  'Headline 4 position','Headline 5 position','Headline 6 position',
  'Headline 7 position','Headline 8 position','Headline 9 position',
  'Headline 10 position','Headline 11 position','Headline 12 position',
  'Headline 13 position','Headline 14 position','Headline 15 position',
  'Description 1 position','Description 2 position','Description 3 position',
  'Description 4 position',
  'IP address','Shared set name','Shared set type','Keyword count','Campaigns',
  'Link Text','Description Line 1','Description Line 2','Upgraded extension',
  'Source','Header','Snippet Values','Callout text','Account settings','Inventory type',
  'Campaign Status','Ad Group Status','Asset Group Status','Status','Approval Status',
  'Ad strength','Comment',
];

/**
 * Maps Google Ads API match types to Ads Editor CSV format.
 * API: "EXACT", "PHRASE", "BROAD"
 * CSV: "Exact", "Phrase", "Broad"
 */
const API_TO_CSV_MATCH = {
  'EXACT':  'Exact',
  'PHRASE': 'Phrase',
  'BROAD':  'Broad',
};

/**
 * Converts Google Ads API match type enum to Ads Editor CSV format.
 *
 * @param {string} apiMatchType - API format: "EXACT", "PHRASE", or "BROAD"
 * @returns {string} CSV format: "Exact", "Phrase", or "Broad"
 */
function toCsvMatchType(apiMatchType) {
  if (!apiMatchType || typeof apiMatchType !== 'string') return 'Exact';
  return API_TO_CSV_MATCH[apiMatchType.toUpperCase()] || 'Exact';
}

/**
 * Converts Ads Editor CSV match type to negative variant.
 *
 * @param {string} csvMatchType - "Exact", "Phrase", or "Broad"
 * @returns {string} "Negative Exact", "Negative Phrase", or "Negative Broad"
 */
function toNegativeCsvMatchType(csvMatchType) {
  return 'Negative ' + csvMatchType;
}

/**
 * Creates a blank row object with all 176 columns set to empty string.
 *
 * @returns {Object} Row with all COLS keys set to ""
 */
function blankRow() {
  const row = {};
  for (const col of COLS) row[col] = '';
  return row;
}

module.exports = { COLS, toCsvMatchType, toNegativeCsvMatchType, blankRow };
