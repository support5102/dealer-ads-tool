const { buildClaudeSystemPrompt, buildUserMessage } = require('../lib/claude-prompts');

describe('buildClaudeSystemPrompt', () => {
  test('single-account prompt includes change schema', () => {
    const prompt = buildClaudeSystemPrompt(false);
    expect(prompt).toContain('pause_campaign');
    expect(prompt).toContain('enable_campaign');
    expect(prompt).toContain('update_budget');
    expect(prompt).toContain('"changes"');
    expect(prompt).toContain('"warnings"');
    expect(prompt).not.toContain('accountChanges');
  });

  test('multi-account prompt includes accountChanges schema', () => {
    const prompt = buildClaudeSystemPrompt(true);
    expect(prompt).toContain('accountChanges');
    expect(prompt).toContain('globalWarnings');
    expect(prompt).toContain('MULTIPLE dealer accounts');
  });

  test('both prompts require JSON only', () => {
    expect(buildClaudeSystemPrompt(false)).toContain('Return ONLY valid JSON');
    expect(buildClaudeSystemPrompt(true)).toContain('Return ONLY valid JSON');
  });

  test('does not include update_bid (removed)', () => {
    expect(buildClaudeSystemPrompt(false)).not.toContain('update_bid');
    expect(buildClaudeSystemPrompt(true)).not.toContain('update_bid');
  });
});

describe('buildUserMessage', () => {
  const mockStructure = {
    campaigns: [
      {
        name: 'Honda Civic - Search',
        status: 'ENABLED',
        type: 'SEARCH',
        budget: '50.00',
        metrics: { impressions: 1000, clicks: 50, cost: '25.00' },
        adGroups: [
          {
            name: 'Ad Group 1',
            status: 'ENABLED',
            defaultBid: '2.00',
            keywords: Array.from({ length: 25 }, (_, i) => ({ text: `keyword${i}` })),
          },
        ],
      },
    ],
  };

  test('returns raw task when no structure', () => {
    expect(buildUserMessage('Pause all', null, 'Test')).toBe('Pause all');
  });

  test('includes account name', () => {
    const msg = buildUserMessage('test task', mockStructure, 'Dealer ABC');
    expect(msg).toContain('ACCOUNT: Dealer ABC');
  });

  test('includes campaign details', () => {
    const msg = buildUserMessage('test', mockStructure, 'Test');
    expect(msg).toContain('Honda Civic - Search');
    expect(msg).toContain('ENABLED');
    expect(msg).toContain('$50.00/day');
    expect(msg).toContain('SEARCH');
  });

  test('includes metrics when available', () => {
    const msg = buildUserMessage('test', mockStructure, 'Test');
    expect(msg).toContain('1000 imp');
    expect(msg).toContain('50 clk');
    expect(msg).toContain('$25.00 spend');
  });

  test('truncates keywords to 20 per ad group', () => {
    const msg = buildUserMessage('test', mockStructure, 'Test');
    expect(msg).toContain('keyword0');
    expect(msg).toContain('keyword19');
    expect(msg).not.toContain('keyword20');
    expect(msg).toContain('+5 more');
  });

  test('includes freshdesk task', () => {
    const msg = buildUserMessage('Pause Honda campaign', mockStructure, 'Test');
    expect(msg).toContain('FRESHDESK TASK:\nPause Honda campaign');
  });
});
