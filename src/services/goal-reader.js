/**
 * Goal Reader — fetches dealer monthly goals from a Google Sheet.
 *
 * Called by: routes/pacing.js (future)
 * Calls: Google Sheets API v4 (via injected sheets client)
 *
 * Reads a single sheet with columns:
 * A: Customer ID | B: Dealer Name | C: Monthly Budget | D: Sales Goal | E: Baseline Inventory
 *
 * The sheets client is injected (not created here) so tests can provide a fake.
 */

/**
 * @typedef {Object} DealerGoal
 * @property {string} customerId - Google Ads customer ID (dashes stripped)
 * @property {string} dealerName - Human-readable dealer name
 * @property {number} monthlyBudget - Monthly budget target in dollars
 * @property {number|null} monthlySalesGoal - Monthly vehicle sales target (null if not set)
 * @property {number|null} baselineInventory - Normal inventory level (null if not set)
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
 * Parses a single row from the goals sheet into a DealerGoal object.
 *
 * @param {string[]} row - Array of cell values from one sheet row
 * @returns {DealerGoal|null} Parsed goal, or null if row is invalid
 */
function parseRow(row) {
  if (!row || !Array.isArray(row)) return null;

  const customerId = cleanCustomerId(row[0]);
  const dealerName = String(row[1] || '').trim();
  const monthlyBudget = parseNumber(row[2]);

  // Minimum viable: must have customer ID, name, and a valid budget
  if (!customerId || !dealerName || monthlyBudget == null || monthlyBudget <= 0) {
    return null;
  }

  return {
    customerId,
    dealerName,
    monthlyBudget,
    monthlySalesGoal: parseNumber(row[3]),
    baselineInventory: parseNumber(row[4]),
  };
}

/**
 * Reads dealer goals from a Google Sheet.
 *
 * @param {Object} sheetsClient - Google Sheets API v4 client (or fake)
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} [range='PPC Spend Pace!A2:E'] - Cell range to read (skip header row)
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
