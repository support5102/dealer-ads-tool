/**
 * Dealer Context Extractor — uses Claude to parse dealer notes into structured context.
 *
 * Called by: routes/budget-adjustments.js (during scan), routes/dealer-context.js
 * Calls: Anthropic REST API via axios (same pattern as claude-parser.js)
 *
 * Takes free-text dealer notes (from Google Sheet or Freshdesk tickets),
 * sends to Claude, returns structured dealer context for use by the
 * auto-adjuster and auditor.
 */

const axios = require('axios');

/**
 * System prompt that tells Claude how to extract dealer advertising context.
 */
function buildSystemPrompt() {
  return `You are a Google Ads account strategist for automotive dealerships.
Analyze dealer notes and extract structured advertising context.

Return ONLY valid JSON, no markdown:

{
  "priorities": ["array of specific advertising priorities"],
  "budgetConstraints": [
    {
      "scope": "campaign_type or campaign_name or account",
      "target": "brand|vla|competitor|regional|service|model_keyword|general or specific campaign name",
      "constraint": "floor or ceiling",
      "amount": number,
      "unit": "daily or monthly",
      "note": "original text that led to this"
    }
  ],
  "modelFocus": [
    {
      "model": "model name lowercase (e.g. f-150, civic, silverado)",
      "action": "push or reduce or pause or monitor",
      "reason": "why"
    }
  ],
  "seasonalNotes": ["time-sensitive context like sales events, clearances"],
  "performanceFeedback": [
    {
      "metric": "cpa or cpc or ctr or impressionShare or conversions or spend",
      "campaignScope": "all or brand or competitor or vla or specific name",
      "sentiment": "too_high or too_low or acceptable",
      "detail": "original feedback text"
    }
  ],
  "confidence": 0.0 to 1.0
}

Rules:
- Only extract what is explicitly stated or strongly implied
- Budget amounts: numbers only, no $ sign
- Model names: lowercase, match common automotive models
- If notes are empty or irrelevant, return {"priorities":[],"budgetConstraints":[],"modelFocus":[],"seasonalNotes":[],"performanceFeedback":[],"confidence":0}
- Set confidence lower for vague or ambiguous language
- "push" means increase budget/priority, "reduce" means decrease`;
}

/**
 * Extracts structured dealer context from free-text notes.
 *
 * @param {Object} claudeConfig - { apiKey, model }
 * @param {string} dealerName - Dealer name for context
 * @param {string} notes - Free-text dealer notes
 * @returns {Promise<Object>} Structured dealer context
 */
async function extractDealerContext(claudeConfig, dealerName, notes) {
  if (!notes || notes.trim().length === 0) {
    return {
      dealerName,
      priorities: [],
      budgetConstraints: [],
      modelFocus: [],
      seasonalNotes: [],
      performanceFeedback: [],
      confidence: 0,
      _meta: { extractedAt: new Date().toISOString(), source: 'empty_notes' },
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userMessage = `DEALER: ${dealerName}\n\nNOTES:\n${notes}`;

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: claudeConfig.model || 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeConfig.apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 30000,
      }
    );

    const raw = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);

    // Validate and sanitize budget constraints
    const validScopes = ['account', 'campaign_type', 'campaign_name'];
    const validConstraints = ['floor', 'ceiling'];
    const budgetConstraints = (parsed.budgetConstraints || []).filter(c =>
      typeof c.amount === 'number' && c.amount > 0 &&
      validScopes.includes(c.scope) &&
      validConstraints.includes(c.constraint)
    );

    // Detect floor > ceiling conflicts for the same scope+target and skip both
    const conflictKeys = new Set();
    for (const c1 of budgetConstraints) {
      for (const c2 of budgetConstraints) {
        if (c1 === c2) continue;
        if (c1.scope === c2.scope && c1.target === c2.target &&
            c1.constraint === 'floor' && c2.constraint === 'ceiling') {
          const floorAmt = c1.unit === 'daily' ? c1.amount : c1.amount / 30;
          const ceilAmt = c2.unit === 'daily' ? c2.amount : c2.amount / 30;
          if (floorAmt > ceilAmt) {
            const key = `${c1.scope}:${c1.target}`;
            conflictKeys.add(key);
            console.warn(`[dealer-context] ${dealerName}: floor ($${floorAmt}/day) > ceiling ($${ceilAmt}/day) for ${key} — skipping both`);
          }
        }
      }
    }
    const safeConstraints = budgetConstraints.filter(c =>
      !conflictKeys.has(`${c.scope}:${c.target}`)
    );

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    return {
      dealerName,
      priorities: parsed.priorities || [],
      budgetConstraints: safeConstraints,
      modelFocus: (parsed.modelFocus || []).filter(f =>
        typeof f.model === 'string' && f.model.length > 0 &&
        ['push', 'reduce', 'pause', 'monitor'].includes(f.action)
      ),
      seasonalNotes: parsed.seasonalNotes || [],
      performanceFeedback: parsed.performanceFeedback || [],
      confidence,
      _meta: {
        extractedAt: new Date().toISOString(),
        source: 'sheet_notes',
        notesLength: notes.length,
        constraintsSkipped: budgetConstraints.length - safeConstraints.length,
      },
    };
  } catch (err) {
    console.warn(`[dealer-context] Failed to extract context for ${dealerName}:`, err.message);
    return {
      dealerName,
      priorities: [],
      budgetConstraints: [],
      modelFocus: [],
      seasonalNotes: [],
      performanceFeedback: [],
      confidence: 0,
      _meta: {
        extractedAt: new Date().toISOString(),
        source: 'extraction_failed',
        error: err.message,
      },
    };
  }
}

module.exports = {
  extractDealerContext,
  buildSystemPrompt,
};
