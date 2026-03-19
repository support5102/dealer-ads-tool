/**
 * Unit tests for goal-reader — verifies parsing of Google Sheets goal data
 * into structured DealerGoal objects.
 *
 * Tier 2 (unit): uses google-sheets-fake, no real API calls.
 *
 * Column layout matches PPC Spend Pace sheet:
 * A: Account (dealer name) | B: Cost (USD) | C: Total Budget
 */

const { readGoals, parseRow, parseNumber, cleanCustomerId } = require('../../src/services/goal-reader');
const {
  createFakeSheetsClient,
  SAMPLE_GOALS_ROWS,
  PARTIAL_ROWS,
  BAD_NUMERIC_ROWS,
  MESSY_ROWS,
} = require('../fakes/google-sheets-fake');

// ===========================================================================
// parseNumber
// ===========================================================================

describe('parseNumber', () => {
  test('parses plain integer string', () => {
    expect(parseNumber('15000')).toBe(15000);
  });

  test('parses decimal string', () => {
    expect(parseNumber('10000.50')).toBe(10000.5);
  });

  test('strips dollar sign', () => {
    expect(parseNumber('$15,000')).toBe(15000);
  });

  test('strips commas', () => {
    expect(parseNumber('10,000')).toBe(10000);
  });

  test('strips whitespace', () => {
    expect(parseNumber(' 15000 ')).toBe(15000);
  });

  test('handles combined formatting ($, commas, spaces)', () => {
    expect(parseNumber(' $15,000.00 ')).toBe(15000);
  });

  test('returns null for empty string', () => {
    expect(parseNumber('')).toBeNull();
  });

  test('returns null for null', () => {
    expect(parseNumber(null)).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(parseNumber(undefined)).toBeNull();
  });

  test('returns null for non-numeric string', () => {
    expect(parseNumber('not-a-number')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(parseNumber('   ')).toBeNull();
  });

  test('parses zero', () => {
    expect(parseNumber('0')).toBe(0);
  });

  test('parses negative number', () => {
    expect(parseNumber('-500')).toBe(-500);
  });

  test('handles raw number input (not string)', () => {
    expect(parseNumber(15000)).toBe(15000);
    expect(parseNumber(0)).toBe(0);
  });
});

// ===========================================================================
// cleanCustomerId
// ===========================================================================

describe('cleanCustomerId', () => {
  test('strips dashes from formatted ID', () => {
    expect(cleanCustomerId('123-456-7890')).toBe('1234567890');
  });

  test('strips whitespace', () => {
    expect(cleanCustomerId('  123-456-7890  ')).toBe('1234567890');
  });

  test('passes through already-clean ID', () => {
    expect(cleanCustomerId('1234567890')).toBe('1234567890');
  });

  test('handles null', () => {
    expect(cleanCustomerId(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(cleanCustomerId(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(cleanCustomerId('')).toBe('');
  });
});

// ===========================================================================
// parseRow (new layout: A=Name, B=Cost, C=Budget)
// ===========================================================================

describe('parseRow', () => {
  test('parses complete row into DealerGoal', () => {
    const goal = parseRow(['Honda of Springfield', '$12,000.00', '$15,000.00']);

    expect(goal).toEqual({
      dealerName: 'Honda of Springfield',
      monthlyBudget: 15000,
    });
  });

  test('parses budget with $ and commas', () => {
    const goal = parseRow(['Honda', '$8,500', '$15,000']);
    expect(goal.monthlyBudget).toBe(15000);
  });

  test('returns null for row missing dealer name', () => {
    expect(parseRow(['', '$12,000', '$15,000'])).toBeNull();
  });

  test('returns null for row missing budget (column C)', () => {
    expect(parseRow(['Honda', '$12,000'])).toBeNull();
  });

  test('returns null for row with zero budget', () => {
    expect(parseRow(['Honda', '$12,000', '0'])).toBeNull();
  });

  test('returns null for row with negative budget', () => {
    expect(parseRow(['Honda', '$12,000', '-500'])).toBeNull();
  });

  test('returns null for row with non-numeric budget', () => {
    expect(parseRow(['Honda', '$12,000', 'abc'])).toBeNull();
  });

  test('returns null for null input', () => {
    expect(parseRow(null)).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(parseRow('not an array')).toBeNull();
  });

  test('returns null for empty array', () => {
    expect(parseRow([])).toBeNull();
  });

  test('returns null for all-empty row', () => {
    expect(parseRow(['', '', ''])).toBeNull();
  });

  test('trims whitespace from dealer name', () => {
    const goal = parseRow(['  Honda of Springfield  ', '$12,000', '$15,000']);
    expect(goal.dealerName).toBe('Honda of Springfield');
  });

  test('ignores extra columns beyond expected three', () => {
    const goal = parseRow(['Honda', '$12,000', '$15,000', '91%', '16', '31']);
    expect(goal).not.toBeNull();
    expect(goal.monthlyBudget).toBe(15000);
  });

  test('cost column (B) does not affect parsing', () => {
    const goal = parseRow(['Honda', 'not-a-number', '$5,000']);
    expect(goal).not.toBeNull();
    expect(goal.monthlyBudget).toBe(5000);
  });
});

// ===========================================================================
// readGoals
// ===========================================================================

describe('readGoals', () => {
  test('parses well-formed sheet data into dealer goals', async () => {
    const client = createFakeSheetsClient(SAMPLE_GOALS_ROWS);
    const goals = await readGoals(client, 'test-spreadsheet-id');

    expect(goals).toHaveLength(3);
    expect(goals[0]).toEqual({
      dealerName: 'Honda of Springfield',
      monthlyBudget: 15000,
    });
    expect(goals[1].dealerName).toBe('Toyota of Shelbyville');
    expect(goals[2].dealerName).toBe('Ford of Capital City');
  });

  test('passes spreadsheetId and range to Sheets API', async () => {
    let capturedParams;
    const client = {
      spreadsheets: {
        values: {
          get: async (params) => {
            capturedParams = params;
            return { data: { values: SAMPLE_GOALS_ROWS } };
          },
        },
      },
    };

    await readGoals(client, 'my-sheet-id', 'CustomRange!A1:Z');

    expect(capturedParams.spreadsheetId).toBe('my-sheet-id');
    expect(capturedParams.range).toBe('CustomRange!A1:Z');
  });

  test('uses default range PPC Spend Pace!A2:C when not specified', async () => {
    let capturedParams;
    const client = {
      spreadsheets: {
        values: {
          get: async (params) => {
            capturedParams = params;
            return { data: { values: [] } };
          },
        },
      },
    };

    await readGoals(client, 'my-sheet-id');
    expect(capturedParams.range).toBe('PPC Spend Pace!A2:C');
  });

  test('skips invalid rows and returns only valid goals', async () => {
    const client = createFakeSheetsClient(PARTIAL_ROWS);
    const goals = await readGoals(client, 'test-id');

    // Row 1: valid, Row 2: valid, Row 3: missing budget, Row 4: all empty
    expect(goals).toHaveLength(2);
    expect(goals[0].dealerName).toBe('Honda of Springfield');
    expect(goals[1].dealerName).toBe('Toyota of Shelbyville');
  });

  test('handles rows with bad numeric data', async () => {
    const client = createFakeSheetsClient(BAD_NUMERIC_ROWS);
    const goals = await readGoals(client, 'test-id');

    // Row 1: budget is 'not-a-number' → skipped
    // Row 2: valid budget → included
    expect(goals).toHaveLength(1);
    expect(goals[0].dealerName).toBe('Toyota of Shelbyville');
  });

  test('handles messy formatting ($, commas, whitespace)', async () => {
    const client = createFakeSheetsClient(MESSY_ROWS);
    const goals = await readGoals(client, 'test-id');

    expect(goals).toHaveLength(2);
    expect(goals[0].dealerName).toBe('Honda of Springfield');
    expect(goals[0].monthlyBudget).toBe(15000);
    expect(goals[1].monthlyBudget).toBe(10000.5);
  });

  test('returns empty array when sheet has no data rows', async () => {
    const client = createFakeSheetsClient([]);
    const goals = await readGoals(client, 'test-id');
    expect(goals).toEqual([]);
  });

  test('returns empty array when values is null', async () => {
    const client = {
      spreadsheets: {
        values: {
          get: async () => ({ data: { values: null } }),
        },
      },
    };
    const goals = await readGoals(client, 'test-id');
    expect(goals).toEqual([]);
  });

  test('returns empty array when values is undefined', async () => {
    const client = {
      spreadsheets: {
        values: {
          get: async () => ({ data: {} }),
        },
      },
    };
    const goals = await readGoals(client, 'test-id');
    expect(goals).toEqual([]);
  });

  test('throws when Sheets API call fails with context in error message', async () => {
    const client = createFakeSheetsClient(null, new Error('API quota exceeded'));
    await expect(readGoals(client, 'my-sheet-123', 'Goals!A2:E'))
      .rejects.toThrow('Failed to read goals from sheet my-sheet-123 range Goals!A2:E: API quota exceeded');
  });

  test('throws when spreadsheetId is missing', async () => {
    const client = createFakeSheetsClient();
    await expect(readGoals(client, ''))
      .rejects.toThrow('Missing spreadsheet ID');
    await expect(readGoals(client, null))
      .rejects.toThrow('Missing spreadsheet ID');
  });

  test('returns all valid goals even when some rows are invalid', async () => {
    const mixedRows = [
      ['Good Dealer',     '$4,000', '$5,000'],
      ['',                '$4,000', '$5,000'],     // missing name
      ['Another Good',    '$7,000', '$8,000'],
      ['Zero Budget',     '$0',     '$0'],          // zero budget
    ];
    const client = createFakeSheetsClient(mixedRows);
    const goals = await readGoals(client, 'test-id');

    expect(goals).toHaveLength(2);
    expect(goals[0].dealerName).toBe('Good Dealer');
    expect(goals[1].dealerName).toBe('Another Good');
  });

  test('duplicate dealer names are both returned (no deduplication)', async () => {
    const dupeRows = [
      ['Honda of Springfield', '$12,000', '$15,000'],
      ['Honda of Springfield', '$10,000', '$12,000'],
    ];
    const client = createFakeSheetsClient(dupeRows);
    const goals = await readGoals(client, 'test-id');

    expect(goals).toHaveLength(2);
    expect(goals[0].dealerName).toBe('Honda of Springfield');
    expect(goals[1].dealerName).toBe('Honda of Springfield');
    expect(goals[0].monthlyBudget).toBe(15000);
    expect(goals[1].monthlyBudget).toBe(12000);
  });
});
