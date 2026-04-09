# All-Accounts Pacing Overview

## Problem

The Budget Pacing Dashboard currently shows pacing data for one dealer at a time. With 60 accounts under the MCC, there's no way to see which dealers are off-pace without clicking through each one individually. We need an overview that shows all dealers' budget pacing status at a glance.

## Scope

- Only accounts with a monthly budget set in Google Sheets are shown
- Summary-level data only (no campaign-level recommendations, impression share, or inventory)
- On-demand parallel fetch, no caching layer
- Account spend overrides (ACCOUNT_OVERRIDES) are NOT applied in the overview — this is a simplified view; full pacing detail with overrides is available by clicking through to the single-account view

## API Design

### `GET /api/pacing/all`

**Authentication:** Requires valid session with Google Ads tokens (same as existing routes).

**Flow:**

1. Read all goals from Google Sheets via `readGoals()` — single API call returns all dealer budgets
2. Get account list from `req.session.accounts` (populated by prior `/api/accounts` call)
3. Match accounts to goals by dealer name: normalize both sides (lowercase, trim, collapse whitespace), then exact match. The `customerId` comes from the account object; `monthlyBudget` comes from the matched goal.
4. Fetch spend data for matched accounts in parallel, batched 10 at a time to avoid Google Ads API rate limits
5. For each account:
   - Call `getMonthSpend(restCtx)` to get per-campaign spend rows — sum all campaign spend to get `mtdSpend`
   - Call a new `getDailySpendLast14Days(restCtx)` query (date range: last 14 calendar days, spanning month boundary) to get per-day spend for 7-day trend calculation
6. Run pacing calculation per account using `pacing-calculator.js` — pass `null` for inventory params (inventory modifiers will not apply in the overview)
7. Map the calculator's `paceStatus` field to response `status`, and `variancePercent` to `pacePercent`
8. Compute `dailyAdjustment` using the calculator's `requiredDailyRate` output minus `dailyAvgSpend` (both already use day-of-week weighting)
9. Compute 7-day trend from the 14-day daily data

**Response shape:**

```json
{
  "accounts": [
    {
      "customerId": "1234567890",
      "dealerName": "Alan Jay Ford - Sebring",
      "monthlyBudget": 15000,
      "mtdSpend": 8432.17,
      "pacePercent": -12.3,
      "status": "under",
      "dailyAdjustment": 42.50,
      "sevenDayAvg": 385.20,
      "sevenDayTrend": "up",
      "sevenDayTrendPercent": 8.1
    }
  ],
  "failed": [
    {
      "customerId": "9876543210",
      "dealerName": "Banner Ford",
      "error": "API timeout"
    }
  ],
  "totalAccounts": 38,
  "loadedAccounts": 37
}
```

**Field definitions:**

| Field | Type | Description |
|-------|------|-------------|
| `customerId` | string | Google Ads customer ID (from account object) |
| `dealerName` | string | Dealer name (from account object's `name` / `descriptive_name`) |
| `monthlyBudget` | number | Monthly budget target (from matched Google Sheets goal) |
| `mtdSpend` | number | Month-to-date total spend — sum of all campaign `spend` values from `getMonthSpend()` |
| `pacePercent` | number | Mapped from calculator's `variancePercent`. -15 = 15% under, +10 = 10% over |
| `status` | string | Mapped from calculator's `paceStatus`: `on_pace` / `under` / `over` / `critical_under` / `critical_over` |
| `dailyAdjustment` | number | `calculator.requiredDailyRate - calculator.dailyAvgSpend`. Positive = increase, negative = decrease |
| `sevenDayAvg` | number | Average daily spend over the last 7 days |
| `sevenDayTrend` | string | `up` / `down` / `flat` |
| `sevenDayTrendPercent` | number | % change in 7-day avg vs. prior 7 days |

**Batching strategy:**

- Accounts are processed in batches of 10
- Each batch runs its API calls in parallel (2 calls per account: month spend + 14-day daily breakdown)
- If a batch hits a rate limit (429 response), wait 5 seconds and retry that batch once
- Individual account failures are captured in the `failed` array, not fatal to the request
- Overall request timeout: 60 seconds. Any accounts not loaded by then go into `failed`.

**New Google Ads query: `getDailySpendLast14Days(restCtx)`**

Unlike `getDailySpendBreakdown` which uses `THIS_MONTH`, this query uses an explicit date range spanning the last 14 calendar days (crossing month boundaries if needed):

```sql
SELECT segments.date, metrics.cost_micros
FROM campaign
WHERE segments.date BETWEEN '{14_days_ago}' AND '{yesterday}'
  AND campaign.status != 'REMOVED'
```

Returns per-day totals (summed across campaigns) for trend calculation.

**7-day trend calculation:**

```
last7 = avg daily spend for days (yesterday-6) to (yesterday)
prior7 = avg daily spend for days (yesterday-13) to (yesterday-7)

if prior7 == 0 and last7 > 0: trend = "up", trendPercent = 100
if prior7 == 0 and last7 == 0: trend = "flat", trendPercent = 0
otherwise: trendPercent = ((last7 - prior7) / prior7) * 100

trend = trendPercent > 3 ? "up" : trendPercent < -3 ? "down" : "flat"
```

Early in the month (< 14 days of data available across months): use whatever days exist. If fewer than 2 days total, report trend as "flat" with 0%.

## Frontend Design

### New page: `pacing-overview.html`

**Layout:**

- Same dark theme, header style, and CSS patterns as existing `pacing.html`
- Header: "Budget Pacing Overview" with navigation link back to single-account view
- Loading state: simple spinner with "Loading all accounts..." (no incremental count — the API returns a single JSON response)
- Main content: single data table

**Table columns:**

| Column | Format | Example |
|--------|--------|---------|
| Dealer Name | text | Alan Jay Ford - Sebring |
| MTD Spend | currency | $8,432.17 |
| Monthly Budget | currency | $15,000.00 |
| Pace % | signed percent, color-coded | -12.3% (yellow) |
| Status | badge with color | Under (yellow) |
| Daily Adj. | signed currency per day | +$42.50/day |
| 7-Day Avg | currency per day | $385.20/day |
| 7-Day Trend | percent with direction | up 8.1% |

**Sorting:** Default sort by status severity (critical_over, critical_under, over, under, on_pace), then alphabetical within each group.

**Row interaction:** Clicking a row navigates to `pacing.html?account=<customerId>` to view that dealer's full pacing detail.

**Navigation between views:**

- `pacing.html` gets a "View All Accounts" button in the header area
- `pacing-overview.html` has a link back and also the row click-through described above

**Status color mapping** (same as existing):

- `on_pace` = green
- `under` / `over` = yellow
- `critical_under` / `critical_over` = red

**Failed accounts:** If any accounts fail to load, show a collapsible section below the table listing them with error messages.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Google Sheets read fails | Fatal error — show message "Could not load budget goals. Check Google Sheets connection." |
| Session has no accounts | Prompt user to click Refresh to load accounts first |
| Individual account API call fails | Skip account, add to `failed` array, show in separate section |
| Rate limit hit (429) | Back off 5 seconds, retry batch once. If still failing, add affected accounts to `failed` |
| No accounts match any goals | Show message "No accounts found with monthly budgets set in Google Sheets." |
| Overall timeout (60s) | Return whatever has loaded so far; unfinished accounts go into `failed` |

## Files to Create/Modify

**New files:**
- `public/pacing-overview.html` — overview page
- `public/pacing-overview-app.js` — client-side logic

**Modified files:**
- `src/routes/pacing.js` — add `GET /api/pacing/all` endpoint
- `src/services/google-ads.js` — add `getDailySpendLast14Days()` query
- `public/pacing.html` — add "View All Accounts" navigation button
- `public/pacing-app.js` — handle deep-link from overview (`?account=` query param auto-selects dealer)

## Out of Scope

- Caching/background refresh (can be added later if load times are an issue)
- Campaign-level detail in the overview
- Impression share or inventory data in the overview
- Account spend overrides (ACCOUNT_OVERRIDES) — overview shows raw per-account spend
- CSV/PDF export
- Filtering or search within the table
