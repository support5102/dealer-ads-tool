/**
 * Unit tests for pacing-engine-v2 — damped daily controller.
 * Tier 2 (unit): pure functions, no external deps.
 */

const {
  proposeAdjustment,
  SAFETY_LIMITS,
} = require('../../src/services/pacing-engine-v2');

// Helper: build a valid input object with overridable fields
function input(overrides = {}) {
  return {
    monthlyBudget: 3000,
    mtdSpend: 1500,
    currentDailyBudget: 100,
    curveId: 'linear',
    year: 2026,
    month: 4, // April = 30 days
    currentDay: 15,
    lastChangeTimestamp: null, // ISO string or null
    bidStrategyType: 'MAXIMIZE_CLICKS',
    ...overrides,
  };
}

describe('proposeAdjustment - happy path', () => {
  test('on-pace account: no adjustment proposed (dead-zone)', () => {
    // Day 15 of 30. Linear cumulative target = 50% = $1500. Actual = $1500. Variance ~0.
    const result = proposeAdjustment(input({ mtdSpend: 1500 }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/dead.?zone|on.?pace/i);
    expect(result.newDailyBudget).toBeNull();
  });

  test('underpacing account: proposes higher daily budget', () => {
    // Day 15 of 30, target $1500, actual $1200 (20% under). Remaining budget $1800
    // over 15 days at linear curve = $120/day. Current = $100. Propose up.
    const result = proposeAdjustment(input({ mtdSpend: 1200 }));
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBeGreaterThan(100);
  });

  test('overpacing account: proposes lower daily budget', () => {
    // Day 15 of 30, target $1500, actual $1800 (20% over). Remaining $1200 / 15 = $80.
    const result = proposeAdjustment(input({ mtdSpend: 1800 }));
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBeLessThan(100);
  });
});

describe('proposeAdjustment - safety rails', () => {
  test('caps single-day increase at +20%', () => {
    // Severe underpacing — required rate would demand >20% hike
    const result = proposeAdjustment(input({
      mtdSpend: 500,  // Way under
      currentDailyBudget: 100,
    }));
    expect(result.newDailyBudget).toBeLessThanOrEqual(120.0 + 0.01);
    expect(result.clampedBy).toBe('max_increase');
  });

  test('caps single-day decrease at -20%', () => {
    const result = proposeAdjustment(input({
      mtdSpend: 2500, // Way over at day 15
      currentDailyBudget: 100,
    }));
    expect(result.newDailyBudget).toBeGreaterThanOrEqual(80.0 - 0.01);
    expect(result.clampedBy).toBe('max_decrease');
  });

  test('freeze window: skips last 2 days of month', () => {
    const result = proposeAdjustment(input({
      currentDay: 29, // day 29 of 30
    }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/freeze|last.*days/i);
  });

  // STRENGTHENING: pins the freeze-window boundary precisely
  test('freeze window boundary: day 28 of 30 is NOT frozen, day 30 IS frozen', () => {
    // Day 28: daysRemaining=2, NOT less than FREEZE_DAYS_AT_EOM(=2). Should run normally.
    const day28 = proposeAdjustment(input({ currentDay: 28, mtdSpend: 1500 }));
    // cumFrac at day 28 of 30 = 0.933; target = 2800; mtd 1500 = way under. Not frozen.
    expect(day28.skipped).toBe(false);

    // Day 30: daysRemaining=0, IS less than 2. Should be frozen.
    const day30 = proposeAdjustment(input({ currentDay: 30 }));
    expect(day30.skipped).toBe(true);
    expect(day30.reason).toMatch(/freeze|last.*days/i);
  });

  test('24h cooldown: skips if last change < 24h ago', () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const result = proposeAdjustment(input({
      mtdSpend: 1200, // underpacing (would normally propose up)
      lastChangeTimestamp: twelveHoursAgo,
    }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/cooldown|recent/i);
  });

  test('3-day cooldown for TARGET_CPA strategies', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = proposeAdjustment(input({
      mtdSpend: 1200,
      lastChangeTimestamp: twoDaysAgo,
      bidStrategyType: 'TARGET_CPA',
    }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/target.*cooldown|3.*day/i);
  });

  test('3-day cooldown for TARGET_ROAS strategies', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = proposeAdjustment(input({
      mtdSpend: 1200,
      lastChangeTimestamp: twoDaysAgo,
      bidStrategyType: 'TARGET_ROAS',
    }));
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/target.*cooldown|3.*day/i);
  });

  test('TARGET_CPA past 3 days: allows adjustment', () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const result = proposeAdjustment(input({
      mtdSpend: 1200,
      lastChangeTimestamp: fourDaysAgo,
      bidStrategyType: 'TARGET_CPA',
    }));
    expect(result.skipped).toBe(false);
  });

  test('absolute floor: never proposes below $5/day', () => {
    const result = proposeAdjustment(input({
      mtdSpend: 2990, // basically fully spent
      currentDailyBudget: 10,
    }));
    if (!result.skipped) {
      expect(result.newDailyBudget).toBeGreaterThanOrEqual(5);
    }
  });

  // STRENGTHENING: forces floor to actually fire
  test('absolute floor: clamps up to $5 when raw would be below', () => {
    // currentDailyBudget=3: maxDecrease=2.4, maxIncrease=3.6.
    // rawRequiredDaily = $50 / 15 days = 3.33. Not beyond either cap.
    // Floor at $5 > 3.33 → floor clamps up to 5.
    const result = proposeAdjustment(input({
      monthlyBudget: 3000,
      mtdSpend: 2950,         // $50 remaining
      currentDailyBudget: 3,
      currentDay: 15,
    }));
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(5);
    expect(result.clampedBy).toBe('floor');
  });

  test('absolute ceiling: never proposes above 3x naive daily rate', () => {
    // monthlyBudget=3000, naive daily = $100, ceiling = $300
    const result = proposeAdjustment(input({
      mtdSpend: 0, // zero spend, would want very high daily
      currentDay: 28,
      currentDailyBudget: 100,
    }));
    expect(result.newDailyBudget).toBeLessThanOrEqual(300 + 0.01);
  });

  test('bidStrategyType is case-insensitive for target strategy detection', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    // Lowercase 'target_cpa' should still trigger the 72h cooldown (48h < 72h → skipped)
    const lower = proposeAdjustment({
      monthlyBudget: 3000, mtdSpend: 1200, currentDailyBudget: 100,
      curveId: 'linear', year: 2026, month: 4, currentDay: 15,
      lastChangeTimestamp: twoDaysAgo, bidStrategyType: 'target_cpa',
    });
    expect(lower.skipped).toBe(true);
    expect(lower.reason).toMatch(/target.*cooldown|3.*day/i);

    // Mixed case 'Target_Roas' should also trigger
    const mixed = proposeAdjustment({
      monthlyBudget: 3000, mtdSpend: 1200, currentDailyBudget: 100,
      curveId: 'linear', year: 2026, month: 4, currentDay: 15,
      lastChangeTimestamp: twoDaysAgo, bidStrategyType: 'Target_Roas',
    });
    expect(mixed.skipped).toBe(true);
  });

  test('clampedBy is null when proposed value is within all bounds', () => {
    // Day 15 of 30, mtd=$1380 → underpacing by 8%. Target=$1500.
    // rawRequired = (3000-1380)/15 = $108. maxIncrease=120. 108 < 120 → no cap.
    // Ceiling=300, floor=5. 108 within. No clamp fires.
    const result = proposeAdjustment({
      monthlyBudget: 3000, mtdSpend: 1380, currentDailyBudget: 100,
      curveId: 'linear', year: 2026, month: 4, currentDay: 15,
      lastChangeTimestamp: null, bidStrategyType: 'MAXIMIZE_CLICKS',
    });
    expect(result.skipped).toBe(false);
    expect(result.clampedBy).toBeNull();
    expect(result.newDailyBudget).toBe(108);
  });

  // STRENGTHENING: forces ceiling to actually fire
  test('absolute ceiling: clamps down to 3x naive when raw+cap would exceed', () => {
    // monthlyBudget=3000, naive=$100, ceiling=$300.
    // currentDailyBudget=400: maxIncrease=480 (greater than ceiling).
    // Day 25 of 30, mtd 0: daysRemaining=5, remainingBudget=3000, raw=600.
    // 600 > 480 → capped at 480. Then 480 > 300 ceiling → clamps to 300.
    const result = proposeAdjustment(input({
      monthlyBudget: 3000,
      mtdSpend: 0,
      currentDailyBudget: 400,
      currentDay: 25,
    }));
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(300);
    expect(result.clampedBy).toBe('ceiling');
  });
});

describe('proposeAdjustment - alanJay9505 curve', () => {
  test('day 10 at 50% linear spend = OVER-pacing (curve wants 31%)', () => {
    // alanJay9505 cumulative at day 10 of 30:
    //   14 days * 0.95 + 16 * 1.05 = 13.3 + 16.8 = 30.1 total weight
    //   first 10 days * 0.95 = 9.5, so cum = 9.5/30.1 = 0.3156 = 31.5%
    // If mtd = $1500 (50% of $3000), we're ~$553 over. Expect decrease.
    const result = proposeAdjustment(input({
      curveId: 'alanJay9505',
      currentDay: 10,
      mtdSpend: 1500,
    }));
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBeLessThan(100);
  });

  test('day 20 spending 67% of budget is close to curve target', () => {
    // alanJay9505 cum at day 20: 14*0.95 + 6*1.05 = 13.3 + 6.3 = 19.6 / 30.1 = 0.6512
    // If mtd = $1954 (65.1% of $3000) — on-pace → dead zone
    const result = proposeAdjustment(input({
      curveId: 'alanJay9505',
      currentDay: 20,
      mtdSpend: 1954,
    }));
    expect(result.skipped).toBe(true);
  });
});

describe('SAFETY_LIMITS constants', () => {
  test('exports expected limits', () => {
    expect(SAFETY_LIMITS.MAX_ADJUSTMENT_PCT).toBe(0.20);
    expect(SAFETY_LIMITS.FREEZE_DAYS_AT_EOM).toBe(2);
    expect(SAFETY_LIMITS.COOLDOWN_HOURS_DEFAULT).toBe(24);
    expect(SAFETY_LIMITS.COOLDOWN_HOURS_TARGET_STRATEGY).toBe(72);
    expect(SAFETY_LIMITS.DEAD_ZONE_PCT).toBe(0.02);
    expect(SAFETY_LIMITS.ABSOLUTE_FLOOR).toBe(5);
    expect(SAFETY_LIMITS.CEILING_MULTIPLIER).toBe(3);
  });
});

// ===========================================================================
// runForAccount - integrates propose + apply + log
// ===========================================================================

describe('runForAccount', () => {
  const { runForAccount } = require('../../src/services/pacing-engine-v2');

  // Minimal fake deps: captures what would be called
  function makeFakes() {
    const applied = [];
    const logged = [];
    return {
      applied,
      logged,
      fakeAccount: {
        customerId: '123-456-7890',
        dealerName: 'Test Dealer',
        goal: {
          dealerName: 'Test Dealer',
          monthlyBudget: 3000,
          pacingMode: 'auto_apply',
          pacingCurveId: 'linear',
        },
        mtdSpend: 1200, // underpacing on day 15 of 30
        currentDailyBudget: 100,
        bidStrategyType: 'MAXIMIZE_CLICKS',
        lastChangeTimestamp: null,
      },
      deps: {
        now: new Date('2026-04-15T06:00:00Z'), // day 15 of April
        applyBudgetChange: async (customerId, newBudget) => {
          applied.push({ customerId, newBudget });
          return { ok: true };
        },
        logChange: async (entry) => {
          logged.push(entry);
          return entry;
        },
      },
    };
  }

  test('auto_apply mode: calls applyBudgetChange + logs', async () => {
    const { fakeAccount, deps, applied, logged } = makeFakes();
    const result = await runForAccount(fakeAccount, deps);

    expect(result.skipped).toBe(false);
    expect(result.applied).toBe(true);
    expect(applied.length).toBe(1);
    expect(applied[0].customerId).toBe('123-456-7890');
    expect(logged.length).toBe(1);
    expect(logged[0].source).toBe('pacing_engine_v2');
    expect(logged[0].action).toBe('update_budget');
  });

  test('one_click mode: logs proposal but does NOT apply', async () => {
    const { fakeAccount, deps, applied, logged } = makeFakes();
    fakeAccount.goal.pacingMode = 'one_click';

    const result = await runForAccount(fakeAccount, deps);

    expect(result.skipped).toBe(false);
    expect(result.applied).toBe(false);
    expect(applied.length).toBe(0);
    expect(logged.length).toBe(1);
    expect(logged[0].source).toBe('pacing_engine_v2_pending');
  });

  test('advisory mode: no apply, no log (purely informational)', async () => {
    const { fakeAccount, deps, applied, logged } = makeFakes();
    fakeAccount.goal.pacingMode = 'advisory';

    const result = await runForAccount(fakeAccount, deps);

    expect(result.applied).toBe(false);
    expect(applied.length).toBe(0);
    expect(logged.length).toBe(0);
    expect(result.proposed).toBeDefined();
  });

  test('skipped proposal: no apply, no log', async () => {
    const { fakeAccount, deps, applied, logged } = makeFakes();
    fakeAccount.mtdSpend = 1500; // on-pace, dead zone

    const result = await runForAccount(fakeAccount, deps);

    expect(result.skipped).toBe(true);
    expect(applied.length).toBe(0);
    expect(logged.length).toBe(0);
  });

  test('apply failure: logs the error, does not throw', async () => {
    const { fakeAccount, deps, applied, logged } = makeFakes();
    deps.applyBudgetChange = async () => { throw new Error('API blew up'); };

    const result = await runForAccount(fakeAccount, deps);

    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/API blew up/);
    expect(logged.length).toBe(1);
    expect(logged[0].success).toBe(false);
  });
});
