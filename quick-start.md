# Quick Start - Dealer Ads Tool V3

> **Trigger:** Say `initialize` to have Claude read this and get oriented.

---

## What Is This?

A web-based Google Ads management tool for car dealer digital marketing teams. Three integrated tools in one:

1. **Task Manager** — Paste Freshdesk tasks in plain English, Claude AI translates to structured Google Ads API changes with review, dry-run, and one-click apply
2. **Campaign Builder** — Build new dealer campaign structures from scratch (auto-fills dealer info via web scraping, generates Ads Editor CSV with model/brand/competitor/regional campaigns)
3. **Pacing Dashboard** — Monitor budget pacing across MCC accounts with Google Sheets goal integration

Connects to Google Ads MCC accounts to manage multiple dealer sub-accounts from one interface.

---

## Live Deployment

| Environment | URL | Service |
|-------------|-----|---------|
| **Production** | https://ads.savvydealer.com | Cloud Run `dealer-ads-tool` |
| **Dev** | https://dealer-ads-tool-dev-840281790428.us-east1.run.app | Cloud Run `dealer-ads-tool-dev` (DEV_MODE=true, blocks Google Ads mutations) |
| **Local** | http://localhost:3000 | |
| **Repository** | https://github.com/support5102/dealer-ads-tool | branch: `V3` (trunk), active feature: `feat/all-accounts-cleanup` |

---

## Current State

| Aspect | Value |
|--------|-------|
| **Phase** | 24: All-Accounts Cleanup — SHIPPED. Phase 24.1 (post-ship stabilization) complete. |
| **Active Branch** | `feat/all-accounts-cleanup` (off `feat/budget-adjust-by-amount`, off `feat/db-goals`) |
| **Last Session** | 2026-05-11 — five post-ship fixes deployed during a week of prod stabilization (Neon pool, Days-Since-Change, Savvy outage circuit-breaker + kill switch, change_event BETWEEN query) |
| **Live Prod Revision** | `dealer-ads-tool-00088-qbm` at https://ads.savvydealer.com |
| **Live Dev Revision** | `dealer-ads-tool-dev-00024-npm` |
| **Feature Flags in Prod (env)** | `BUDGET_ADJUST_BY_AMOUNT_ENABLED=true`, `BUDGET_REVERT_REMINDERS_ENABLED=true`, `ALL_ACCOUNTS_CLEANUP_ENABLED=true`, `USE_DB_GOALS=true`, `PACING_ENGINE_V2_ENABLED=true`, `SAVVY_INVENTORY_DISABLED=true` ← **revert when Savvy API recovers** |
| **Immediate Next** | (a) verify Savvy Incentive API is healthy, then remove `SAVVY_INVENTORY_DISABLED` env var; (b) confirm Days-Since-Change populates correctly after the `BETWEEN` fix; (c) decide on next feature (sGTM cert monitor + Savvy health monitor was sketched) |

---

## Data Flow

```
User pastes Freshdesk task in browser
    ↓
POST /api/parse-task — routes/changes.js
    ↓
Build Claude prompt with account structure — services/claude-parser.js
    ↓
Anthropic API → structured JSON change plan
    ↓
Display plan in browser (summary, changes, warnings)
    ↓
POST /api/apply-changes — routes/changes.js
    ↓
Execute each change — services/change-executor.js
    ↓
Google Ads API mutations — services/google-ads.js
    ↓
Return results to browser
```

---

## Key Commands

```bash
# Development
npm run dev

# Testing
npm test                    # All tests
npm run test:config         # Tier 1 only
npm run test:unit           # Tier 2 only
npm run test:integration    # Tier 3 only
npm run test:coverage       # With coverage report

# Local Server
npm start

# Deploy to Cloud Run (NOT Railway anymore — moved to Google Cloud Run)
# From the active worktree:
gcloud run deploy dealer-ads-tool-dev --source=. --region=us-east1 --quiet   # dev
gcloud run deploy dealer-ads-tool     --source=. --region=us-east1 --quiet   # prod (live!)
```

---

## File Locations

| What | Where |
|------|-------|
| Source code | `src/` |
| Routes | `src/routes/` |
| Services | `src/services/` |
| Middleware | `src/middleware/` |
| Frontend | `public/` |
| Tests | `tests/` |
| Config | `.env` / `src/utils/config.js` |
| Documentation | root (`claude.md`, `project-state.md`) |
| V2 reference | V2 branch on GitHub |

---

## Tech Stack

- **Language:** JavaScript (Node.js 18+)
- **Framework:** Express.js
- **Testing:** Jest
- **AI Integration:** Anthropic Claude API (task parsing)
- **Ads API:** google-ads-api npm package
- **Deployment:** Google Cloud Run (project `railway-ads-tool`, region `us-east1`); Postgres on Neon (pooler URL on both dev and prod)

---

## Machine Mode

**SINGLE:** All work happens locally / in Railway cloud.

---

## Start Here

1. Claude reads THIS file only at initialization
2. Claude summarizes current state and asks what we're focusing on
3. Claude confirms session scope: "This session: [task]. Staying focused on this."
4. Claude loads additional context ONLY for the chosen focus area
5. Check session log in project-state.md if resuming mid-work

---

## Context Note

Claude: After reading this file, DO NOT automatically read all of claude.md or project-state.md. Ask what we're working on first, then load only what's relevant. See "Context Management" section in claude.md for the full approach.

---

*For full development guidelines, TDD practices, code documentation standards, and architecture details, see `claude.md`.*
