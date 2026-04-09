/**
 * Fake Claude API — test double for Anthropic API responses via axios.
 *
 * Used by: tests/unit/test_claude_parser.js
 *
 * Instead of mocking axios globally, tests inject this fake into parseTask
 * by overriding the axios module's post method.
 */

/**
 * Creates a fake axios post response matching the Anthropic API format.
 *
 * @param {Object} changePlan - The JSON change plan to return
 * @returns {Object} Fake axios response { data: { content: [{ text }] } }
 */
function fakeClaudeResponse(changePlan) {
  return {
    data: {
      content: [{
        type: 'text',
        text: JSON.stringify(changePlan),
      }],
    },
  };
}

/**
 * Creates a fake response with markdown-wrapped JSON (tests cleanup logic).
 */
function fakeClaudeResponseWithMarkdown(changePlan) {
  return {
    data: {
      content: [{
        type: 'text',
        text: '```json\n' + JSON.stringify(changePlan) + '\n```',
      }],
    },
  };
}

/**
 * Creates a fake response with invalid JSON.
 */
function fakeClaudeInvalidResponse(rawText) {
  return {
    data: {
      content: [{
        type: 'text',
        text: rawText || 'This is not valid JSON at all',
      }],
    },
  };
}

/**
 * Creates a fake response with empty content.
 */
function fakeClaudeEmptyResponse() {
  return { data: { content: [] } };
}

/**
 * A sample valid change plan for reuse across tests.
 */
const SAMPLE_CHANGE_PLAN = {
  summary: 'Pause Honda Civic campaign and add negative keyword',
  changes: [
    {
      type: 'pause_campaign',
      campaignName: 'Honda Civic - Search',
    },
    {
      type: 'add_negative_keyword',
      campaignName: 'Honda Civic - Search',
      details: { keyword: 'free cars', matchType: 'EXACT' },
    },
  ],
  warnings: ['Verify this is the correct Honda campaign'],
  affectedCampaigns: ['Honda Civic - Search'],
};

module.exports = {
  fakeClaudeResponse,
  fakeClaudeResponseWithMarkdown,
  fakeClaudeInvalidResponse,
  fakeClaudeEmptyResponse,
  SAMPLE_CHANGE_PLAN,
};
