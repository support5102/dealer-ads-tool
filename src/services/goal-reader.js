/**
 * Goal Reader — fetches dealer monthly goals from a Google Sheet.
 *
 * Called by: routes/pacing.js
 * Calls: Google Sheets API v4 (via injected sheets client)
 *
 * Reads the "PPC Control" sheet with columns:
 * A: Account (dealer name) | B: Budget | C: New | D: Used | E: Misc | F: Pacing Mode | G: Pacing Curve
 *
 * The sheets client is injected (not created here) so tests can provide a fake.
 */

/**
 * @typedef {Object} DealerGoal
 * @property {string} dealerName - Human-readable dealer name (used for matching)
 * @property {number} monthlyBudget - Monthly budget target in dollars
 * @property {number|null} baselineInventory - Normal new vehicle count (for inventory modifier)
 * @property {string|null} dealerNotes - Free-text notes about dealer preferences, priorities, constraints
 * @property {string|null} freshdeskTag - Freshdesk tag for matching tickets to this dealer
 * @property {'auto_apply'|'one_click'|'advisory'} pacingMode - Pacing strategy mode; defaults to 'one_click'. Case-insensitive on input; stored as lowercase canonical form.
 * @property {string|null} pacingCurveId - Curve registry ID, or null to use account default
 */

/**
 * Valid pacing mode allowlist. Exported for use by Task 4.x consumers.
 */
const VALID_PACING_MODES = new Set(['auto_apply', 'one_click', 'advisory']);

/**
 * Cleans a numeric string: strips $, commas, whitespace, then parses as float.
 *
 * @param {string} val - Raw cell value
 * @returns {number|null} Parsed number or null if unparseable
 */
function parseNumber(val) {
  if (val == null || String(val).trim() === '') return null;
  const cleaned = String(val).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Strips dashes and whitespace from a customer ID.
 *
 * @param {string} id - Raw customer ID (e.g., '123-456-7890')
 * @returns {string} Cleaned ID (e.g., '1234567890')
 */
function cleanCustomerId(id) {
  return String(id || '').replace(/[-\s]/g, '').trim();
}

/**
 * Parses a single row from the PPC Control sheet into a DealerGoal object.
 *
 * Column layout: A=Account Name, B=Budget, C=New, D=Used, E=Misc, F=Pacing Mode, G=Pacing Curve
 *
 * @param {string[]} row - Array of cell values from one sheet row
 * @returns {DealerGoal|null} Parsed goal, or null if row is invalid
 */
function parseRow(row) {
  if (!row || !Array.isArray(row)) return null;

  const dealerName = String(row[0] || '').trim();
  const monthlyBudget = parseNumber(row[1]); // Column B = Budget
  // Minimum viable: must have dealer name and a valid budget
  if (!dealerName || monthlyBudget == null || monthlyBudget <= 0) {
    return null;
  }

  // PPC Control columns: C=New, D=Used, E=Misc
  const newBudget = parseNumber(row[2]);
  const usedBudget = parseNumber(row[3]);
  const miscNotes = row[4] != null ? String(row[4]).trim() : null;

  // Phase 1 additions: columns F (Pacing Mode) + G (Pacing Curve)
  const rawMode = row[5] != null ? String(row[5]).trim().toLowerCase() : '';
  const pacingMode = VALID_PACING_MODES.has(rawMode) ? rawMode : 'one_click';

  const rawCurve = row[6] != null ? String(row[6]).trim() : '';
  const pacingCurveId = rawCurve === '' ? null : rawCurve;

  return {
    dealerName,
    monthlyBudget,
    baselineInventory: null,
    dealerNotes: miscNotes || null,
    freshdeskTag: null,
    newBudget: newBudget || null,
    usedBudget: usedBudget || null,
    pacingMode,
    pacingCurveId,
  };
}

/**
 * Reads dealer goals from a Google Sheet.
 *
 * @param {Object} sheetsClient - Google Sheets API v4 client (or fake)
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} [range='PPC Control!A2:G'] - Cell range to read (skip header row)
 * @returns {Promise<DealerGoal[]>} Array of parsed dealer goals (invalid rows skipped)
 * @throws {Error} If the Sheets API call fails
 */
async function readGoals(sheetsClient, spreadsheetId, range = 'PPC Control!A2:G') {
  if (!spreadsheetId) {
    throw new Error(
      'Missing spreadsheet ID. Set GOOGLE_SHEETS_SPREADSHEET_ID in your environment.'
    );
  }

  let response;
  try {
    response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
  } catch (err) {
    throw new Error(
      `Failed to read goals from sheet ${spreadsheetId} range ${range}: ${err.message}`
    );
  }

  const rows = response.data.values;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const goals = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (parsed) {
      goals.push(parsed);
    }
  }

  return goals;
}

/**
 * Reads dealer-specific budget splits (VLA vs Keyword) from a separate sheet.
 * Used by Alan Jay stores that have fixed VLA/Keyword budget allocations.
 *
 * Column layout: A=Store, B=PPC QTY, C=PPC MGMT FEE, D=PPC Budget, E=VLA Budget, F=Keyword Budget
 *
 * @param {Object} sheetsClient - Google Sheets API v4 client
 * @param {string} spreadsheetId - Spreadsheet ID for the budget splits sheet
 * @param {string} [sheetName] - Sheet/tab name (defaults to first sheet)
 * @returns {Promise<Map<string, {vlaBudget: number, keywordBudget: number}>>} Map of dealer name → budget splits
 */
async function readBudgetSplits(sheetsClient, spreadsheetId, sheetName) {
  if (!spreadsheetId) return new Map();

  const range = sheetName ? `${sheetName}!A2:F` : 'A2:F';
  let response;
  try {
    response = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  } catch (err) {
    console.warn('readBudgetSplits failed (non-fatal):', err.message);
    return new Map();
  }

  const rows = response.data.values || [];
  const splits = new Map();

  for (const row of rows) {
    const store = String(row[0] || '').trim();
    if (!store) continue;

    const ppcBudget = parseNumber(row[3]);    // Column D: PPC Budget
    const vlaBudget = parseNumber(row[4]);    // Column E: VLA Budget
    const keywordBudget = parseNumber(row[5]); // Column F: Keyword Budget

    if (vlaBudget != null || keywordBudget != null) {
      splits.set(store.toLowerCase(), {
        ppcBudget: ppcBudget || 0,
        vlaBudget: vlaBudget || 0,
        keywordBudget: keywordBudget || 0,
      });
    }
  }

  return splits;
}

module.exports = {
  readGoals,
  readBudgetSplits,
  parseRow,
  parseNumber,
  cleanCustomerId,
  VALID_PACING_MODES,
};
