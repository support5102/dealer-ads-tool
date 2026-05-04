/**
 * Pure math for budget adjustments. No DB, no I/O.
 *
 * compute({ scope, amount, daySubScope, currentMonthly, currentDaily, newTotal, today })
 *   returns { newMonthlyBudget, newDailyBudget, dailyBudgetWritten }
 *
 * `scope`:
 *   'day'           — requires daySubScope ∈ {'forward','whole_month'}
 *   'rest_of_month' — daily_budget left unchanged (dailyBudgetWritten=false)
 *   'month'         — monthly += amount; daily synced to new_monthly/D
 *   'set_total'     — user-typed newTotal; daily synced to newTotal/D
 */

function daysInMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function daysRemainingInclusive(date) {
  return daysInMonth(date) - date.getUTCDate() + 1;
}

function firstOfNextMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function compute(opts) {
  const { scope, amount, daySubScope, currentMonthly, newTotal, today } = opts;

  if (!today || !(today instanceof Date)) {
    throw new Error('today is required and must be a Date');
  }
  const D = daysInMonth(today);
  const R = daysRemainingInclusive(today);

  let newMonthlyBudget;
  let newDailyBudget;
  let dailyBudgetWritten;

  if (scope === 'set_total') {
    if (typeof newTotal !== 'number' || !Number.isFinite(newTotal) || newTotal <= 0) {
      throw new Error('newTotal must be a positive number for scope=set_total');
    }
    newMonthlyBudget = newTotal;
    newDailyBudget = round2(newTotal / D);
    dailyBudgetWritten = true;
  } else if (scope === 'day') {
    if (daySubScope !== 'forward' && daySubScope !== 'whole_month') {
      throw new Error('daySubScope must be "forward" or "whole_month" when scope="day"');
    }
    requireFiniteNonZero(amount, 'amount');
    const oldDaily = currentMonthly / D;
    const newDaily = oldDaily + amount;
    if (newDaily <= 0) {
      throw new Error('Resulting daily_budget must be positive');
    }
    newDailyBudget = round2(newDaily);
    if (daySubScope === 'forward') {
      newMonthlyBudget = round2(currentMonthly + amount * R);
    } else {
      newMonthlyBudget = round2(newDaily * D);
    }
    dailyBudgetWritten = true;
  } else if (scope === 'rest_of_month') {
    requireFiniteNonZero(amount, 'amount');
    newMonthlyBudget = round2(currentMonthly + amount);
    newDailyBudget = null;
    dailyBudgetWritten = false;
  } else if (scope === 'month') {
    requireFiniteNonZero(amount, 'amount');
    newMonthlyBudget = round2(currentMonthly + amount);
    newDailyBudget = round2(newMonthlyBudget / D);
    dailyBudgetWritten = true;
  } else {
    throw new Error(`Unknown scope: ${scope}`);
  }

  if (newMonthlyBudget <= 0) {
    throw new Error('Resulting monthly_budget must be positive');
  }

  return { newMonthlyBudget, newDailyBudget, dailyBudgetWritten };
}

function requireFiniteNonZero(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    throw new Error(`${name} must be a finite non-zero number`);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { compute, firstOfNextMonth, daysInMonth, daysRemainingInclusive };
