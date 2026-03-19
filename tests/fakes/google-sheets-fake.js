/**
 * Fake Google Sheets API — test double for googleapis Sheets v4 responses.
 *
 * Used by: tests/unit/test_goal_reader.js
 *
 * Mimics the Google Sheets API values.get response format:
 * { data: { values: [[row1col1, row1col2, ...], [row2col1, ...]] } }
 *
 * Column layout matches PPC Spend Pace sheet:
 * A: Account (dealer name) | B: Cost (USD) | C: Total Budget
 */

/**
 * Well-formed goal sheet data matching the PPC Spend Pace column layout:
 * Account Name | Cost (USD) | Total Budget
 */
const SAMPLE_GOALS_ROWS = [
  ['Honda of Springfield',    '$12,000.00', '$15,000.00'],
  ['Toyota of Shelbyville',   '$8,500.00',  '$10,000.00'],
  ['Ford of Capital City',    '$18,000.00', '$20,000.00'],
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
              range: params.range || 'PPC Spend Pace!A2:C',
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
  ['Honda of Springfield',    '$12,000.00', '$15,000.00'],  // complete
  ['Toyota of Shelbyville',   '$8,500.00',  '$10,000.00'],  // complete
  ['Ford of Capital City',    '$18,000.00'],                  // missing budget
  ['', '', ''],                                               // all empty
];

/**
 * Rows with bad numeric data.
 */
const BAD_NUMERIC_ROWS = [
  ['Honda of Springfield',    '$12,000.00', 'not-a-number'],   // bad budget
  ['Toyota of Shelbyville',   'abc',        '$10,000.00'],     // bad cost (irrelevant), valid budget
];

/**
 * Rows with extra whitespace and formatting artifacts.
 */
const MESSY_ROWS = [
  ['  Honda of Springfield  ', ' $12,000 ', ' $15,000 '],
  ['Toyota of Shelbyville',    '$8,500',    '10,000.50'],
];

module.exports = {
  createFakeSheetsClient,
  SAMPLE_GOALS_ROWS,
  PARTIAL_ROWS,
  BAD_NUMERIC_ROWS,
  MESSY_ROWS,
};
