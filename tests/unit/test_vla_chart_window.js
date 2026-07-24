/**
 * Tests for the VLA charts 30-day window densifier.
 *
 * Google omits days with zero activity from GAQL results, so a campaign that
 * only ran part of the window comes back with a short `days` array. The charts
 * page builds each card's x-axis from the union of that dealer's campaign
 * dates, so a dealer whose campaigns are all short renders a shorter axis than
 * 30 days — and any day where every campaign was dark vanishes from the axis
 * entirely, silently distorting the time scale.
 *
 * These cover: every campaign must span the identical, continuous 30-day
 * window ending yesterday, zero-filled where there was no activity.
 */

const { buildDateWindow, densifyCampaigns, latestDate } = require('../../src/services/vla-chart-window');

describe('buildDateWindow', () => {
  test('returns 30 continuous dates ending at the anchor (inclusive)', () => {
    const dates = buildDateWindow('2026-07-15', 30);
    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe('2026-06-16');
    expect(dates[29]).toBe('2026-07-15');
  });

  test('has no gaps — each date is exactly one day after the previous', () => {
    const dates = buildDateWindow('2026-07-15', 30);
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + 'T00:00:00Z');
      const cur = new Date(dates[i] + 'T00:00:00Z');
      expect(cur - prev).toBe(86_400_000);
    }
  });

  test('crosses a month boundary correctly', () => {
    const dates = buildDateWindow('2026-03-02', 5);
    expect(dates).toEqual(['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});

describe('latestDate', () => {
  test('finds the max date across all dealers/campaigns (that is "yesterday")', () => {
    const dealers = [
      { campaigns: [{ days: [{ date: '2026-07-02' }, { date: '2026-07-15' }] }] },
      { campaigns: [{ days: [{ date: '2026-07-14' }] }] },
    ];
    expect(latestDate(dealers)).toBe('2026-07-15');
  });

  test('returns null when there is no data at all', () => {
    expect(latestDate([{ campaigns: [{ days: [] }] }])).toBeNull();
  });
});

describe('densifyCampaigns', () => {
  const dates = buildDateWindow('2026-07-15', 30);

  test('a short campaign is zero-filled across the full window (the Bob Weaver CDJR bug)', () => {
    // Real case: "Pmax - CDJR New VLAs" returned only 2026-07-02..2026-07-15.
    const campaigns = [{
      campaignId: '1',
      name: 'Pmax - CDJR New VLAs',
      days: [
        { date: '2026-07-14', clicks: 5, impressions: 100, cost: 2.5 },
        { date: '2026-07-15', clicks: 7, impressions: 120, cost: 3.0 },
      ],
    }];

    const out = densifyCampaigns(campaigns, dates);

    expect(out[0].days).toHaveLength(30);
    expect(out[0].days[0]).toEqual({ date: '2026-06-16', clicks: 0, impressions: 0, cost: 0 });
    expect(out[0].days[29]).toEqual({ date: '2026-07-15', clicks: 7, impressions: 120, cost: 3.0 });
    expect(out[0].days.map(d => d.date)).toEqual(dates); // identical, continuous axis
  });

  test('preserves real values and keeps ascending date order', () => {
    const out = densifyCampaigns(
      [{ campaignId: '1', name: 'A', days: [{ date: '2026-07-01', clicks: 3, impressions: 50, cost: 1 }] }],
      dates
    );
    const jul1 = out[0].days.find(d => d.date === '2026-07-01');
    expect(jul1).toEqual({ date: '2026-07-01', clicks: 3, impressions: 50, cost: 1 });
    expect(out[0].days.map(d => d.date)).toEqual([...out[0].days.map(d => d.date)].sort());
  });

  test('every campaign ends up on the SAME axis regardless of its own coverage', () => {
    const out = densifyCampaigns([
      { campaignId: '1', name: 'Full',  days: dates.map(d => ({ date: d, clicks: 1, impressions: 1, cost: 1 })) },
      { campaignId: '2', name: 'Short', days: [{ date: '2026-07-15', clicks: 9, impressions: 9, cost: 9 }] },
    ], dates);

    expect(out[0].days.map(d => d.date)).toEqual(out[1].days.map(d => d.date));
    expect(out[1].days).toHaveLength(30);
  });

  test('a campaign with no days at all becomes a full zero series', () => {
    const out = densifyCampaigns([{ campaignId: '1', name: 'Dark', days: [] }], dates);
    expect(out[0].days).toHaveLength(30);
    expect(out[0].days.every(d => d.clicks === 0 && d.impressions === 0 && d.cost === 0)).toBe(true);
  });
});
