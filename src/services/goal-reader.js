/**
 * Goal Reader — fetches dealer monthly goals from a Google Sheet.
 *
 * Called by: routes/pacing.js
 * Calls: Google Sheets API v4 (via injected sheets client)
 *
 * Reads the "PPC Spend Pace" sheet with columns:
 * A: Account (dealer name) | B: Cost (USD) | C: Total Budget | D: Baseline Inventory | E: Dealer Notes
 *
 * The sheets client is injected (not created here) so tests can provide a fake.
 */

/**
 * @typedef {Object} DealerGoal
 * @property {string} dealerName - Human-readable dealer name (used for matching)
 * @property {number} monthlyBudget - Monthly budget target in dollars
 * @property {number|null} baselineInventory - Normal new vehicle count (for inventory modifier)
 * @property {string|null} dealerNotes - Free-text notes about dealer preferences, priorities, constraints
 */

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
 * Parses a single row from the PPC Spend Pace sheet into a DealerGoal object.
 *
 * Column layout: A=Account Name, B=Cost (USD), C=Total Budget, D=Baseline Inventory, E=Dealer Notes
 *
 * @param {string[]} row - Array of cell values from one sheet row
 * @returns {DealerGoal|null} Parsed goal, or null if row is invalid
 */
function parseRow(row) {
  if (!row || !Array.isArray(row)) return null;

  const dealerName = String(row[0] || '').trim();
  const monthlyBudget = parseNumber(row[2]);
  // Minimum viable: must have dealer name and a valid budget
  if (!dealerName || monthlyBudget == null || monthlyBudget <= 0) {
    return null;
  }

  const baselineInventory = parseNumber(row[3]);
  const dealerNotes = row[4] != null ? String(row[4]).trim() : null;

  return {
    dealerName,
    monthlyBudget,
    baselineInventory: baselineInventory || null,
    dealerNotes: dealerNotes || null,
  };
}

/**
 * Reads dealer goals from a Google Sheet.
 *
 * @param {Object} sheetsClient - Google Sheets API v4 client (or fake)
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} [range='PPC Spend Pace!A2:C'] - Cell range to read (skip header row)
 * @returns {Promise<DealerGoal[]>} Array of parsed dealer goals (invalid rows skipped)
 * @throws {Error} If the Sheets API call fails
 */
async function readGoals(sheetsClient, spreadsheetId, range = 'PPC Spend Pace!A2:E') {
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

module.exports = {
  readGoals,
  parseRow,
  parseNumber,
  cleanCustomerId,
};
