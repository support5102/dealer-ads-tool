/**
 * Tier 2 Unit Tests — csv-exporter.js
 *
 * Tests: src/services/csv-exporter.js
 */

const { changeToRows, changesToRows, toCSV } = require('../../src/services/csv-exporter');
const { COLS } = require('../../src/utils/ads-editor-columns');

describe('csv-exporter', () => {

  describe('changeToRows', () => {

    test('pause_campaign produces one row with Campaign Status Paused', () => {
      const result = changeToRows({
        type: 'pause_campaign',
        campaignName: 'Honda Civic - Search',
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Campaign Status']).toBe('Paused');
    });

    test('enable_campaign produces one row with Campaign Status Enabled', () => {
      const result = changeToRows({
        type: 'enable_campaign',
        campaignName: 'Honda Civic - Search',
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Campaign Status']).toBe('Enabled');
    });

    test('update_budget produces one row with Budget and Budget type', () => {
      const result = changeToRows({
        type: 'update_budget',
        campaignName: 'Honda Civic - Search',
        details: { newBudget: '75.50' },
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Budget']).toBe('75.50');
      expect(result.rows[0]['Budget type']).toBe('Daily');
    });

    test('pause_ad_group produces one row with Ad Group Status Paused', () => {
      const result = changeToRows({
        type: 'pause_ad_group',
        campaignName: 'Honda Civic - Search',
        adGroupName: 'SD: 2025 Honda Civic',
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Ad Group']).toBe('SD: 2025 Honda Civic');
      expect(result.rows[0]['Ad Group Status']).toBe('Paused');
    });

    test('enable_ad_group produces one row with Ad Group Status Enabled', () => {
      const result = changeToRows({
        type: 'enable_ad_group',
        campaignName: 'Honda Civic - Search',
        adGroupName: 'SD: 2025 Honda Civic',
      });
      expect(result.skipped).toBe(false);
      expect(result.rows[0]['Ad Group Status']).toBe('Enabled');
    });

    test('pause_keyword produces one row with Status Paused and match type', () => {
      const result = changeToRows({
        type: 'pause_keyword',
        campaignName: 'Honda Civic - Search',
        adGroupName: 'SD: 2025 Honda Civic',
        details: { keyword: '2025 honda civic', matchType: 'EXACT' },
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Ad Group']).toBe('SD: 2025 Honda Civic');
      expect(result.rows[0]['Keyword']).toBe('2025 honda civic');
      expect(result.rows[0]['Criterion Type']).toBe('Exact');
      expect(result.rows[0]['Status']).toBe('Paused');
    });

    test('add_keyword produces one row with keyword, match type, CPC, and Status Enabled', () => {
      const result = changeToRows({
        type: 'add_keyword',
        campaignName: 'Honda Civic - Search',
        adGroupName: 'SD: 2025 Honda Civic',
        details: { keyword: 'honda civic deals', matchType: 'PHRASE', cpcBid: '4.50' },
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Keyword']).toBe('honda civic deals');
      expect(result.rows[0]['Criterion Type']).toBe('Phrase');
      expect(result.rows[0]['Max CPC']).toBe('4.50');
      expect(result.rows[0]['Status']).toBe('Enabled');
    });

    test('add_keyword without cpcBid leaves Max CPC empty', () => {
      const result = changeToRows({
        type: 'add_keyword',
        campaignName: 'Test',
        adGroupName: 'AG',
        details: { keyword: 'test', matchType: 'BROAD' },
      });
      expect(result.rows[0]['Max CPC']).toBe('');
    });

    test('add_negative_keyword produces campaign-level negative with empty Ad Group', () => {
      const result = changeToRows({
        type: 'add_negative_keyword',
        campaignName: 'Honda Civic - Search',
        details: { keyword: 'free cars', matchType: 'PHRASE' },
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Ad Group']).toBe('');
      expect(result.rows[0]['Keyword']).toBe('free cars');
      expect(result.rows[0]['Criterion Type']).toBe('Negative Phrase');
    });

    test('add_negative_keyword defaults match type to Exact when not provided', () => {
      const result = changeToRows({
        type: 'add_negative_keyword',
        campaignName: 'Test',
        details: { keyword: 'junk' },
      });
      expect(result.rows[0]['Criterion Type']).toBe('Negative Exact');
    });

    test('add_radius produces location row with encoded lat/lng', () => {
      const result = changeToRows({
        type: 'add_radius',
        campaignName: 'Honda Civic - Search',
        details: { lat: 41.663900, lng: -83.555300, radius: 20, units: 'MILES' },
      });
      expect(result.skipped).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]['Campaign']).toBe('Honda Civic - Search');
      expect(result.rows[0]['Location']).toBe('(20mi:41.663900:-83.555300)');
      expect(result.rows[0]['Radius']).toBe('20');
      expect(result.rows[0]['Unit']).toBe('mi');
    });

    test('add_radius does not set Campaign Status (avoids re-enabling paused campaigns)', () => {
      const result = changeToRows({
        type: 'add_radius',
        campaignName: 'Paused Campaign',
        details: { lat: 40.0, lng: -80.0, radius: 15 },
      });
      expect(result.rows[0]['Campaign Status']).toBe('');
      expect(result.rows[0]['Status']).toBe('Enabled');
    });

    test('add_radius handles km and KM unit strings', () => {
      const r1 = changeToRows({ type: 'add_radius', campaignName: 'T', details: { lat: 0, lng: 0, radius: 10, units: 'km' } });
      expect(r1.rows[0]['Unit']).toBe('km');
      const r2 = changeToRows({ type: 'add_radius', campaignName: 'T', details: { lat: 0, lng: 0, radius: 10, units: 'KM' } });
      expect(r2.rows[0]['Unit']).toBe('km');
      const r3 = changeToRows({ type: 'add_radius', campaignName: 'T', details: { lat: 0, lng: 0, radius: 10, units: 'KILOMETERS' } });
      expect(r3.rows[0]['Unit']).toBe('km');
    });

    test('add_radius defaults units to mi when not specified', () => {
      const result = changeToRows({
        type: 'add_radius',
        campaignName: 'Test',
        details: { lat: 40.0, lng: -80.0, radius: 15 },
      });
      expect(result.rows[0]['Unit']).toBe('mi');
    });

    test('exclude_radius is skipped with reason', () => {
      const result = changeToRows({
        type: 'exclude_radius',
        campaignName: 'Honda Civic - Search',
        details: { lat: 41.66, lng: -83.55, radius: 10 },
      });
      expect(result.skipped).toBe(true);
      expect(result.rows).toHaveLength(0);
      expect(result.skipReason).toContain('exclude_radius');
      expect(result.skipReason).toContain('Honda Civic - Search');
    });

    test('unknown change type is skipped with reason', () => {
      const result = changeToRows({
        type: 'magic_spell',
        campaignName: 'Test',
      });
      expect(result.skipped).toBe(true);
      expect(result.rows).toHaveLength(0);
      expect(result.skipReason).toContain('magic_spell');
    });

    test('change types requiring details skip gracefully when details is missing', () => {
      const types = ['update_budget', 'pause_keyword', 'add_keyword', 'add_negative_keyword', 'add_radius', 'exclude_radius'];
      for (const type of types) {
        const result = changeToRows({ type, campaignName: 'Test' });
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('missing details');
        expect(result.rows).toHaveLength(0);
      }
    });

    test('rows only populate relevant columns, all others are empty', () => {
      const result = changeToRows({
        type: 'pause_campaign',
        campaignName: 'Test Campaign',
      });
      const row = result.rows[0];
      const populated = Object.entries(row).filter(([, v]) => v !== '');
      // Should only have Campaign and Campaign Status populated
      expect(populated).toHaveLength(2);
      expect(populated.map(([k]) => k).sort()).toEqual(['Campaign', 'Campaign Status']);
    });
  });

  describe('changesToRows', () => {
    test('combines rows from multiple changes', () => {
      const { rows, skipped } = changesToRows([
        { type: 'pause_campaign', campaignName: 'Camp A' },
        { type: 'enable_campaign', campaignName: 'Camp B' },
      ]);
      expect(rows).toHaveLength(2);
      expect(skipped).toHaveLength(0);
    });

    test('collects skip reasons for unsupported types', () => {
      const { rows, skipped } = changesToRows([
        { type: 'pause_campaign', campaignName: 'Camp A' },
        { type: 'exclude_radius', campaignName: 'Camp B', details: { lat: 0, lng: 0, radius: 5 } },
      ]);
      expect(rows).toHaveLength(1);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain('exclude_radius');
    });

    test('handles empty changes array', () => {
      const { rows, skipped } = changesToRows([]);
      expect(rows).toHaveLength(0);
      expect(skipped).toHaveLength(0);
    });
  });

  describe('toCSV', () => {
    test('produces header row with all 176 columns', () => {
      const csv = toCSV([]);
      const lines = csv.split('\r\n');
      // First char is BOM
      expect(csv.charCodeAt(0)).toBe(0xFEFF);
      const header = lines[0].replace('\uFEFF', '');
      const cols = header.split('\t');
      expect(cols).toHaveLength(176);
      expect(cols[0]).toBe('Campaign');
    });

    test('includes data rows after header', () => {
      const { rows } = changesToRows([
        { type: 'pause_campaign', campaignName: 'Test Campaign' },
      ]);
      const csv = toCSV(rows);
      const lines = csv.split('\r\n');
      expect(lines).toHaveLength(2); // header + 1 data row

      // Find Campaign column index
      const header = lines[0].replace('\uFEFF', '').split('\t');
      const campIdx = header.indexOf('Campaign');
      const statusIdx = header.indexOf('Campaign Status');

      const data = lines[1].split('\t');
      expect(data[campIdx]).toBe('Test Campaign');
      expect(data[statusIdx]).toBe('Paused');
    });

    test('sanitizes tabs and newlines in field values to prevent CSV injection', () => {
      const { rows } = changesToRows([
        { type: 'pause_campaign', campaignName: 'Camp\twith\ttabs' },
      ]);
      const csv = toCSV(rows);
      const lines = csv.replace('\uFEFF', '').split('\r\n');
      const data = lines[1];
      // Tabs in the campaign name should be replaced with spaces
      expect(data).toContain('Camp with tabs');
      // Should still have exactly 176 columns (175 tabs)
      expect(data.split('\t')).toHaveLength(176);
    });

    test('produces 176 tab-separated values per row', () => {
      const { rows } = changesToRows([
        { type: 'pause_campaign', campaignName: 'A' },
      ]);
      const csv = toCSV(rows);
      const lines = csv.split('\r\n');
      const dataCols = lines[1].split('\t');
      expect(dataCols).toHaveLength(176);
    });
  });
});
