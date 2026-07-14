# Historical Monthly Spend — Design

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Repo:** dealer-ads-tool (branch `feat/account-builder-v2`)

## Problem

The pacing overview (`pacing-overview.html`, "All Dealer Accounts") shows each dealer's
month-to-date (MTD) spend pulled live from Google Ads on every page load. Nothing is
persisted, so there is no way to compare a dealer's spend across months. We want each
dealer's **total monthly spend** recorded so we can look back at historical months.

## Goals

- Persist each dealer's total monthly spend, one figure per dealer per calendar month.
- Let the user see a dealer's month history by clicking its row on the pacing overview.
- Require no new Google Ads API quota and no new always-on scheduling infrastructure.

## Non-goals (explicitly out of scope for this pass)

- A cross-dealer comparison grid / dedicated history page.
- A "last month" column on the overview table.
- CSV export.
- Backfilling months prior to ship (no data source exists for it — see Limitations).

## Key constraint that shapes the design

There is **no reliable always-on server job** that pulls spend. Every spend pull needs a
logged-in user's OAuth refresh token:

- `GET /api/pacing/all` runs on demand when someone opens the overview.
- `spend-sync.js` (daily 8 AM ET) is **not auto-enabled** — a user must POST
  `/api/spend-sync/enable`, and it runs off a session refresh token.
- The `scheduler.js` background jobs are feature-flagged stubs (empty `listAccounts`).

So we cannot rely on a cron firing at month-end. The design works around this.

## Capture strategy: daily upsert, latest-wins

Instead of snapshotting once at month-end, we **upsert the current month's running total
on every capture opportunity**, keyed by `(dealer_name, period)` where `period` is the
first day of the month.

Why this converges to the correct month-end total: Google Ads MTD spend grows through the
month and **resets to 0 on the 1st**. So the July row is repeatedly overwritten with July's
growing total, and the last upsert while the calendar still reads July leaves the final
July figure in place (the period boundary is computed in UTC, so the finalized figure can
under-count the final calendar day's timezone-offset tail — a known minor caveat, tracked
as a follow-up). When August starts, a new `(dealer, 2026-08-01)` row begins.

Capture opportunities (both fire-and-forget, never block or fail the request):

1. **`GET /api/pacing/all`** — after `results[]` is built (each element already has
   `dealerName`, `mtdSpend`, `monthlyBudget`), upsert one row per dealer. This is the
   primary feed; it runs whenever anyone loads the overview.
2. **`spend-sync.runSpendSync()`** — when enabled, it already builds `spendByName`; upsert
   the same rows there as a second feed. (Budget may not be in scope there; store `NULL`
   if unavailable.)

**Failure mode, surfaced not hidden:** if nobody opens the overview for the last several
days of a month, that month's stored total is stale by a few days. We store `updated_at`
and show it in the UI so a stale figure is visible, never silently wrong.

## Data model

New table, created in `src/services/database.js` `initialize()` using the same
`try/catch` + `CREATE TABLE IF NOT EXISTS` pattern as `dealer_goals`:

```sql
CREATE TABLE IF NOT EXISTS dealer_monthly_spend (
  dealer_name    TEXT        NOT NULL,
  period         DATE        NOT NULL,          -- first of month, e.g. 2026-07-01
  total_spend    NUMERIC(12,2) NOT NULL,
  monthly_budget NUMERIC(10,2),                 -- budget in effect that month, for comparison
  source         TEXT,                          -- 'pacing-overview' | 'spend-sync'
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (dealer_name, period)
);
CREATE INDEX IF NOT EXISTS idx_dealer_monthly_spend_dealer
  ON dealer_monthly_spend (dealer_name, period DESC);
```

Snapshotting `monthly_budget` alongside spend means the history shows spend vs. the budget
that was actually in effect that month, not today's budget.

## New store module: `src/services/dealer-spend-history-store.js`

Mirrors `dealer-goals-store.js`: PostgreSQL path when `DATABASE_URL` is set, in-memory
`Map` fallback otherwise, plus `_resetForTesting()`. All spend values coerced via `Number`.

- `recordSpend({ dealerName, period, totalSpend, monthlyBudget, source })` — upsert,
  `ON CONFLICT (dealer_name, period) DO UPDATE SET total_spend = EXCLUDED.total_spend,
  monthly_budget = EXCLUDED.monthly_budget, source = EXCLUDED.source, updated_at = NOW()`.
  `period` is normalized to the first of the month by the caller (helper `monthPeriod(date)`).
- `getSpendHistory(dealerName)` — returns `[{ period, totalSpend, monthlyBudget, updatedAt }]`
  newest first.

A small `recordManyForCurrentMonth(rows, source)` convenience wraps a loop of `recordSpend`
for the capture hooks, swallowing per-row errors so one bad row can't abort the batch.

## API

`GET /api/dealers/:dealerName/spend-history` (in `src/routes/dealers.js`, `requireAuth`),
mirroring the existing `GET /api/dealers/:dealerName/history` budget-history endpoint.
Returns `{ history: [{ period, totalSpend, monthlyBudget, updatedAt }] }` newest first.

## UI: expand a dealer row on the pacing overview

File: `public/pacing-overview-app.js` (+ styles in `public/pacing-styles.css`).

Current behavior: clicking a row navigates to `/pacing.html?account=…`
(`<tr onclick="window.location.href=…">`, line ~292). We must not break that.

- Add a leading **chevron toggle** cell (or a caret on the dealer name). Its click handler
  calls `event.stopPropagation()` — same guard the budget-edit pencil already uses — so
  clicking the caret expands/collapses while clicking the rest of the row still navigates.
- On first expand, lazy-`fetch` `/api/dealers/:dealerName/spend-history`, cache in a
  module-level `Map` (like `dealers-app.js` does with `state.history`), and render an inline
  detail `<tr>` beneath the dealer.
- Row format, newest first:
  `Jun 2026 · $18,900 spent / $20,450 budget · 92%   (updated Jul 1)`
  - `%` = `total_spend / monthly_budget` when budget present, else omit.
  - Show `updated_at` so staleness is visible.
  - Empty state: "No months recorded yet — history starts this month."

## Limitations (state plainly to the user)

- **No backfill.** The Google Sheet holds only *current* cost, so there is no source for
  past months. History begins accumulating the day this ships; the current partial month
  is captured immediately and finalizes at month rollover.
- A month's figure can be a few days stale if the overview isn't opened near month-end;
  the shown `updated_at` makes this visible.

## Testing

Mirror the existing Jest suite (`tests/`):

- **Store unit tests** (in-memory mode): same `(dealer, period)` upsert overwrites rather
  than duplicating; distinct periods accumulate separate rows; `getSpendHistory` returns
  newest first; `Number` coercion; `_resetForTesting` clears state.
- **Capture-hook test:** given a `results[]`-shaped array, the capture helper calls
  `recordSpend` once per dealer with the correct current-month `period`; a throwing row
  does not abort the batch.
- **API test:** `GET /api/dealers/:dealerName/spend-history` returns stored rows newest
  first (follow the pattern of the existing budget-history route test).

## Files touched

- `src/services/database.js` — add `dealer_monthly_spend` table + index.
- `src/services/dealer-spend-history-store.js` — **new** store module.
- `src/routes/pacing.js` — fire-and-forget capture after `results[]` in `/api/pacing/all`.
- `src/services/spend-sync.js` — second capture feed when enabled.
- `src/routes/dealers.js` — `GET /api/dealers/:dealerName/spend-history`.
- `public/pacing-overview-app.js` — row expand + history render.
- `public/pacing-styles.css` — expand/detail-row styles.
- `tests/` — store, capture-hook, and API tests.
