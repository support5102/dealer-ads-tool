# Dealer Ads Tool — Quick Start

## What is this?
Google Ads management tool for automotive dealerships. Paste a Freshdesk task in plain English, Claude AI parses it into structured changes, preview them, then apply to Google Ads.

## Run locally
```bash
cp env.example .env   # fill in credentials
npm install
npm start             # http://localhost:3000
npm test              # run 29 unit tests
```

## Required env vars
- `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` — OAuth
- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_MANAGER_ACCOUNT_ID` — Google Ads
- `ANTHROPIC_API_KEY` — Claude AI
- `SESSION_SECRET` — session encryption
- `PORT` (default 3000)

## Architecture
- `server.js` — Express routes and orchestration (~1180 lines)
- `public/index.html` — Frontend UI
- `lib/apply-change.js` — Google Ads mutation logic
- `lib/claude-prompts.js` — Claude prompt builders
- `lib/history.js` — Persistent file-based history
- `tests/` — Jest unit tests

## Deployment
Railway via Nixpacks. Config in `railway.json`. Health check at `/health`.

## Current state
All 9 phases + budget tracker + production hardening complete. Modular architecture with extracted frontend, libraries, and tests. Supports single/multi-account task parsing, batch apply, persistent change history with undo, smart suggestions, NL reporting, task templates, budget spend tracking, and Freshdesk webhook. Production-ready with secure cookies, CORS restrictions, and trust proxy for Railway. See `project-state.md` for full details.
