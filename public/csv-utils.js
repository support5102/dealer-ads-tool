/**
 * CSV Utils — shared Google Ads Editor CSV helpers for browser pages.
 *
 * Used by: public/builder.html (Campaign Builder), public/app.js (change export)
 *
 * Provides the 176-column array, blank row factory, and CSV serializer
 * matching the Google Ads Editor import format.
 *
 * This is the browser-side equivalent of src/utils/ads-editor-columns.js
 * (server-side). Both must stay in sync — the column list is identical.
 */

// eslint-disable-next-line no-unused-vars
var ADS_COLS = [
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
 * Creates a blank row object with all 176 columns set to empty string.
 * @returns {Object}
 */
// eslint-disable-next-line no-unused-vars
function blankAdsRow() {
  var row = {};
  for (var i = 0; i < ADS_COLS.length; i++) row[ADS_COLS[i]] = '';
  return row;
}

/**
 * Serializes row objects to tab-separated CSV with UTF-8 BOM.
 * Sanitizes tabs/newlines in values to prevent column shift.
 * @param {Object[]} rows - Array of row objects keyed by ADS_COLS
 * @returns {string} CSV string ready for Blob download
 */
// eslint-disable-next-line no-unused-vars
function buildAdsCSV(rows) {
  var lines = [ADS_COLS.join('\t')];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var parts = [];
    for (var j = 0; j < ADS_COLS.length; j++) {
      var v = r[ADS_COLS[j]];
      parts.push((v !== undefined && v !== null) ? String(v).replace(/[\t\r\n]/g, ' ') : '');
    }
    lines.push(parts.join('\t'));
  }
  return '\uFEFF' + lines.join('\r\n');
}
