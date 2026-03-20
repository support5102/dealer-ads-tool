const { applyChange, gaqlEscape, VALID_MATCH_TYPES } = require('../lib/apply-change');

// ─────────────────────────────────────────────────────────────
// gaqlEscape tests
// ─────────────────────────────────────────────────────────────
describe('gaqlEscape', () => {
  test('doubles single quotes', () => {
    expect(gaqlEscape("Honda's Best")).toBe("Honda''s Best");
  });

  test('escapes backslashes', () => {
    expect(gaqlEscape('path\\value')).toBe('path\\\\value');
  });

  test('handles normal strings unchanged', () => {
    expect(gaqlEscape('Honda Civic - Search')).toBe('Honda Civic - Search');
  });

  test('throws on empty string', () => {
    expect(() => gaqlEscape('')).toThrow('Empty or invalid');
  });

  test('throws on null', () => {
    expect(() => gaqlEscape(null)).toThrow('Empty or invalid');
  });

  test('throws on non-string', () => {
    expect(() => gaqlEscape(123)).toThrow('Empty or invalid');
  });

  test('throws on string over 500 chars', () => {
    const long = 'a'.repeat(501);
    expect(() => gaqlEscape(long)).toThrow('too long');
  });

  test('accepts string at exactly 500 chars', () => {
    const str = 'a'.repeat(500);
    expect(gaqlEscape(str)).toBe(str);
  });

  test('handles combined escapes', () => {
    expect(gaqlEscape("it's a \\test")).toBe("it''s a \\\\test");
  });
});

// ─────────────────────────────────────────────────────────────
// VALID_MATCH_TYPES
// ─────────────────────────────────────────────────────────────
describe('VALID_MATCH_TYPES', () => {
  test('contains EXACT, PHRASE, BROAD', () => {
    expect(VALID_MATCH_TYPES).toEqual(['EXACT', 'PHRASE', 'BROAD']);
  });
});

// ─────────────────────────────────────────────────────────────
// applyChange tests
// ─────────────────────────────────────────────────────────────
describe('applyChange', () => {
  const mockClient = {
    credentials: { customer_id: '1234567890' },
    query: jest.fn(),
    campaigns: { update: jest.fn() },
    adGroups: { update: jest.fn() },
    adGroupCriteria: { update: jest.fn(), create: jest.fn() },
    campaignCriteria: { create: jest.fn() },
    campaignBudgets: { update: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('dry run returns preview string', async () => {
    const result = await applyChange(mockClient, {
      type: 'pause_campaign',
      campaignName: 'Test Campaign',
    }, true);
    expect(result).toContain('[DRY RUN]');
    expect(result).toContain('pause_campaign');
    expect(result).toContain('Test Campaign');
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  test('pause_campaign queries then updates', async () => {
    mockClient.query.mockResolvedValueOnce([{ campaign: { id: '555' } }]);
    mockClient.campaigns.update.mockResolvedValueOnce({});

    const result = await applyChange(mockClient, {
      type: 'pause_campaign',
      campaignName: 'Honda Civic - Search',
    }, false);

    expect(result).toContain('Paused campaign');
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockClient.campaigns.update).toHaveBeenCalledWith([{
      resource_name: 'customers/1234567890/campaigns/555',
      status: 'PAUSED',
    }]);
  });

  test('campaign not found throws descriptive error', async () => {
    mockClient.query.mockResolvedValueOnce([]);

    await expect(applyChange(mockClient, {
      type: 'pause_campaign',
      campaignName: 'Nonexistent',
    }, false)).rejects.toThrow('Campaign not found: "Nonexistent"');
  });

  test('enable_campaign works', async () => {
    mockClient.query.mockResolvedValueOnce([{ campaign: { id: '777' } }]);
    mockClient.campaigns.update.mockResolvedValueOnce({});

    const result = await applyChange(mockClient, {
      type: 'enable_campaign',
      campaignName: 'Test',
    }, false);
    expect(result).toContain('Enabled campaign');
  });

  test('update_budget updates micros correctly', async () => {
    mockClient.query
      .mockResolvedValueOnce([{ campaign: { id: '111' } }])
      .mockResolvedValueOnce([{ campaign_budget: { resource_name: 'customers/1234567890/campaignBudgets/999', amount_micros: 50000000 } }]);
    mockClient.campaignBudgets.update.mockResolvedValueOnce({});

    const result = await applyChange(mockClient, {
      type: 'update_budget',
      campaignName: 'Test',
      details: { newBudget: '200.00' },
    }, false);

    expect(result).toContain('$200.00/day');
    expect(mockClient.campaignBudgets.update).toHaveBeenCalledWith([{
      resource_name: 'customers/1234567890/campaignBudgets/999',
      amount_micros: 200000000,
    }]);
  });

  test('pause_ad_group works', async () => {
    mockClient.query.mockResolvedValueOnce([{ ad_group: { id: '333' } }]);
    mockClient.adGroups.update.mockResolvedValueOnce({});

    const result = await applyChange(mockClient, {
      type: 'pause_ad_group',
      campaignName: 'Campaign',
      adGroupName: 'Ad Group 1',
    }, false);
    expect(result).toContain('Paused ad group');
  });

  test('add_negative_keyword creates criterion', async () => {
    mockClient.query.mockResolvedValueOnce([{ campaign: { id: '444' } }]);
    mockClient.campaignCriteria.create.mockResolvedValueOnce({});

    const result = await applyChange(mockClient, {
      type: 'add_negative_keyword',
      campaignName: 'Test',
      details: { keyword: 'free cars', matchType: 'EXACT' },
    }, false);
    expect(result).toContain('negative keyword');
    expect(mockClient.campaignCriteria.create).toHaveBeenCalledWith([expect.objectContaining({
      negative: true,
      keyword: { text: 'free cars', match_type: 'EXACT' },
    })]);
  });

  test('rejects invalid match type', async () => {
    await expect(applyChange(mockClient, {
      type: 'add_keyword',
      campaignName: 'Test',
      adGroupName: 'AG',
      details: { keyword: 'test', matchType: 'INVALID' },
    }, false)).rejects.toThrow('Invalid match type');
  });

  test('unknown change type throws', async () => {
    await expect(applyChange(mockClient, {
      type: 'delete_everything',
      campaignName: 'Test',
    }, false)).rejects.toThrow('Unknown change type');
  });
});
