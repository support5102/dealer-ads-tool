# Quick Start - Dealer Ads Tool V3

> **Trigger:** Say `initialize` to have Claude read this and get oriented.

---

## What Is This?

A web-based Google Ads management tool for car dealer digital marketing teams. Users paste Freshdesk support tasks in plain English (e.g., "pause the Honda Civic campaign", "add negative keyword [free cars] to all campaigns"), and the tool uses Claude AI to translate them into structured Google Ads API changes — with review, dry-run preview, and one-click apply. Connects to Google Ads MCC accounts to manage multiple dealer sub-accounts from one interface.

---

## Live Deployment

| Environment | URL |
|-------------|-----|
| **Production** | Railway (TBD after V3 deploy) |
| **Local** | http://localhost:3000 |
| **Repository** | https://github.com/support5102/dealer-ads-tool (branch: V3) |
| **V2 Reference** | https://github.com/support5102/dealer-ads-tool/tree/V2 |

---

## Current State

| Aspect | Value |
|--------|-------|
| **Phase** | 0: Planning - COMPLETE |
| **Last Session** | 2026-03-10 - CLEAN |
| **Immediate Next** | Phase 1: Split monolith into modules |
| **Live Version** | V2 on Railway (V3 not yet deployed) |

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

# Deploy to Railway
git push origin V3          # Railway auto-deploys from branch
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
- **Deployment:** Railway (Nixpacks)

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
