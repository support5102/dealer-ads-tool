/**
 * CSV Exporter — converts change plans to Google Ads Editor CSV format.
 *
 * Called by: routes/changes.js (POST /api/export-changes-csv)
 * Uses: utils/ads-editor-columns.js for column definitions
 *
 * Maps the 10 change types from the change executor to sparse 176-column
 * CSV rows that Google Ads Editor can import. Only populates the columns
 * relevant to each change type — all others stay empty.
 *
 * Note: exclude_radius has no CSV encoding in Ads Editor and is skipped
 * with a warning.
 */

const { COLS, toCsvMatchType, toNegativeCsvMatchType, blankRow } = require('../utils/ads-editor-columns');

/**
 * Converts a single change object to one or more CSV row objects.
 *
 * @param {Object} change - Structured change from Claude parser
 * @param {string} change.type - One of the 10 supported change types
 * @param {string} change.campaignName - Exact campaign name
 * @param {string} [change.adGroupName] - Ad group name (if applicable)
 * @param {Object} [change.details] - Type-specific details
 * @returns {{ rows: Object[], skipped: boolean, skipReason?: string }}
 */
function changeToRows(change) {
  const { type, campaignName, adGroupName, details } = change;

  // Guard: types that require details
  const NEEDS_DETAILS = ['update_budget', 'pause_keyword', 'add_keyword', 'add_negative_keyword', 'add_radius', 'exclude_radius'];
  if (NEEDS_DETAILS.includes(type) && !details) {
    return {
      rows: [],
      skipped: true,
      skipReason: `${type} missing details for "${campaignName}" — cannot export to CSV`,
    };
  }

  switch (type) {
    case 'pause_campaign': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Campaign Status'] = 'Paused';
      return { rows: [row], skipped: false };
    }

    case 'enable_campaign': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Campaign Status'] = 'Enabled';
      return { rows: [row], skipped: false };
    }

    case 'update_budget': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Budget'] = String(details.newBudget);
      row['Budget type'] = 'Daily';
      return { rows: [row], skipped: false };
    }

    case 'pause_ad_group': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Ad Group'] = adGroupName;
      row['Ad Group Status'] = 'Paused';
      return { rows: [row], skipped: false };
    }

    case 'enable_ad_group': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Ad Group'] = adGroupName;
      row['Ad Group Status'] = 'Enabled';
      return { rows: [row], skipped: false };
    }

    case 'pause_keyword': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Ad Group'] = adGroupName || '';
      row['Keyword'] = details.keyword;
      row['Criterion Type'] = toCsvMatchType(details.matchType);
      row['Status'] = 'Paused';
      return { rows: [row], skipped: false };
    }

    case 'add_keyword': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      row['Ad Group'] = adGroupName;
      row['Keyword'] = details.keyword;
      row['Criterion Type'] = toCsvMatchType(details.matchType);
      row['Max CPC'] = details.cpcBid || '';
      row['Status'] = 'Enabled';
      return { rows: [row], skipped: false };
    }

    case 'add_negative_keyword': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      // Ad Group intentionally empty — campaign-level negative
      row['Keyword'] = details.keyword;
      row['Criterion Type'] = toNegativeCsvMatchType(
        toCsvMatchType(details.matchType || 'EXACT')
      );
      return { rows: [row], skipped: false };
    }

    case 'add_radius': {
      const row = blankRow();
      row['Campaign'] = campaignName;
      const lat = Number(details.lat).toFixed(6);
      const lng = Number(details.lng).toFixed(6);
      const r = details.radius;
      const lower = (details.units || 'MILES').toLowerCase();
      const unit = (lower === 'kilometers' || lower === 'km') ? 'km' : 'mi';
      row['Location'] = `(${r}${unit}:${lat}:${lng})`;
      row['Radius'] = String(r);
      row['Unit'] = unit;
      row['Status'] = 'Enabled';
      return { rows: [row], skipped: false };
    }

    case 'exclude_radius': {
      // No CSV encoding for negative lat/lng radius in Ads Editor
      return {
        rows: [],
        skipped: true,
        skipReason: `exclude_radius cannot be exported to CSV — use API to apply: ${campaignName} (${details.radius}mi at ${details.lat},${details.lng})`,
      };
    }

    default:
      return {
        rows: [],
        skipped: true,
        skipReason: `Unknown change type "${type}" — cannot export to CSV`,
      };
  }
}

/**
 * Converts an array of change objects to Ads Editor CSV rows.
 *
 * @param {Object[]} changes - Array of change objects from Claude parser
 * @returns {{ rows: Object[], skipped: string[] }} Rows and skip reasons
 */
function changesToRows(changes) {
  const allRows = [];
  const skipped = [];

  for (const change of changes) {
    const result = changeToRows(change);
    allRows.push(...result.rows);
    if (result.skipped) {
      skipped.push(result.skipReason);
    }
  }

  return { rows: allRows, skipped };
}

/**
 * Serializes row objects to tab-separated CSV with UTF-8 BOM.
 * Compatible with Google Ads Editor import.
 *
 * @param {Object[]} rows - Array of row objects keyed by COLS
 * @returns {string} Tab-separated CSV string with BOM
 */
function toCSV(rows) {
  const header = COLS.join('\t');
  const lines = [header];

  for (const row of rows) {
    const line = COLS.map(col => {
      const val = row[col];
      if (val === undefined || val === null) return '';
      // Strip tabs and newlines to prevent CSV injection / column shift
      return String(val).replace(/[\t\r\n]/g, ' ');
    }).join('\t');
    lines.push(line);
  }

  // UTF-8 BOM + content
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { changeToRows, changesToRows, toCSV };
