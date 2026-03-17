/**
 * Fake Google Sheets API — test double for googleapis Sheets v4 responses.
 *
 * Used by: tests/unit/test_goal_reader.js
 *
 * Mimics the Google Sheets API values.get response format:
 * { data: { values: [[row1col1, row1col2, ...], [row2col1, ...]] } }
 */

/**
 * Well-formed goal sheet data matching the expected column layout:
 * Customer ID | Dealer Name | Monthly Budget | Sales Goal | Baseline Inventory
 */
const SAMPLE_GOALS_ROWS = [
  ['123-456-7890', 'Honda of Springfield',    '15000', '45', '200'],
  ['234-567-8901', 'Toyota of Shelbyville',   '10000', '30', '150'],
  ['345-678-9012', 'Ford of Capital City',    '20000', '60', '300'],
];

/**
 * Creates a fake Sheets API client that returns canned data.
 *
 * @param {string[][]} [rows=SAMPLE_GOALS_ROWS] - 2D array of cell values
 * @param {Error} [error] - If provided, get() rejects with this error
 * @returns {Object} Fake sheets client matching googleapis interface
 */
function createFakeSheetsClient(rows = SAMPLE_GOALS_ROWS, error = null) {
  return {
    spreadsheets: {
      values: {
        get: async (params) => {
          if (error) throw error;
          return {
            data: {
              values: rows,
              range: params.range || 'PPC Spend Pace!A2:E',
              majorDimension: 'ROWS',
            },
          };
        },
      },
    },
  };
}

/**
 * Rows with missing/partial data for edge case testing.
 */
const PARTIAL_ROWS = [
  ['123-456-7890', 'Honda of Springfield', '15000', '45', '200'],  // complete
  ['234-567-8901', 'Toyota of Shelbyville', '10000', '', ''],      // missing sales goal + inventory
  ['345-678-9012', 'Ford of Capital City'],                         // only ID and name
  ['', '', '', '', ''],                                              // all empty
];

/**
 * Rows with bad numeric data.
 */
const BAD_NUMERIC_ROWS = [
  ['123-456-7890', 'Honda of Springfield', 'not-a-number', '45', '200'],
  ['234-567-8901', 'Toyota of Shelbyville', '10000', 'abc', 'xyz'],
];

/**
 * Rows with extra whitespace and formatting artifacts.
 */
const MESSY_ROWS = [
  ['  123-456-7890  ', '  Honda of Springfield  ', ' $15,000 ', ' 45 ', ' 200 '],
  ['234-567-8901', 'Toyota of Shelbyville', '10,000.50', '30', '150'],
];

module.exports = {
  createFakeSheetsClient,
  SAMPLE_GOALS_ROWS,
  PARTIAL_ROWS,
  BAD_NUMERIC_ROWS,
  MESSY_ROWS,
};
