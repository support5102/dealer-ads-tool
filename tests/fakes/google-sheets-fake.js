/**
 * Fake Google Sheets API — test double for googleapis Sheets v4 responses.
 *
 * Used by: tests/unit/test_goal_reader.js
 *
 * Mimics the Google Sheets API values.get response format:
 * { data: { values: [[row1col1, row1col2, ...], [row2col1, ...]] } }
 *
 * Column layout matches PPC Control sheet:
 * A: Account (dealer name) | B: Monthly Budget | C: New Budget | D: Used Budget | E: Misc | F: Pacing Mode | G: Pacing Curve
 */

/**
 * Well-formed goal sheet data matching the PPC Control column layout:
 * Account | Monthly Budget | New Budget | Used Budget | Misc
 */
const SAMPLE_GOALS_ROWS = [
  ['Honda of Springfield',    '$15,000.00', '$9,000.00',  '$6,000.00', '200'],
  ['Toyota of Shelbyville',   '$10,000.00', '$6,000.00',  '$4,000.00', '150'],
  ['Ford of Capital City',    '$20,000.00', '$12,000.00', '$8,000.00', '300'],
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
              range: params.range || 'PPC Control!A2:G',
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
  ['Honda of Springfield',    '$15,000.00', '$9,000.00', '$6,000.00', '200'],  // complete
  ['Toyota of Shelbyville',   '$10,000.00'],                                    // valid (budget only)
  ['Ford of Capital City'],                                                     // missing budget -> skipped
  ['', '', ''],                                                                 // all empty -> skipped
];

/**
 * Rows with bad numeric data.
 */
const BAD_NUMERIC_ROWS = [
  ['Honda of Springfield',    'not-a-number', '$9,000.00'],   // bad budget (col B) -> skipped
  ['Toyota of Shelbyville',   '$10,000.00',   'abc'],          // valid budget (col B), bad newBudget -> included
];

/**
 * Rows with extra whitespace and formatting artifacts.
 */
const MESSY_ROWS = [
  ['  Honda of Springfield  ', ' $15,000 ', ' $9,000 '],
  ['Toyota of Shelbyville',    '10,000.50', '$6,000'],
];

module.exports = {
  createFakeSheetsClient,
  SAMPLE_GOALS_ROWS,
  PARTIAL_ROWS,
  BAD_NUMERIC_ROWS,
  MESSY_ROWS,
};
