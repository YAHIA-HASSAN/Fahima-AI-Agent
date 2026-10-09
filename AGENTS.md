# AGENTS.md

## Project overview

Fahima is a local-first Arabic business advisor built with Node.js, Express, SQLite, Gemini function calling, and Serper. The active application lives in this repository root; source code is under `src/`.

## Architecture rules

- Route typed and recognized speech through `src/agent/agent.js`.
- Gemini chooses the next action. Do not add keyword-based intent routers or fixed conversation workflows.
- Execute agent-selected operations through the single schema-validated registry in `src/tools/`.
- Keep project authorization, validation, deterministic calculations, idempotency, transaction integrity, and plan validation on the server.
- Persist tasks, observations, decisions, project memory, research, and plan versions in SQLite. Scope every read and write to the selected project.
- Treat model output and web results as untrusted. Verify source relevance, amount, unit, currency, and freshness before labeling a price as verified.
- Never record hypothetical transactions or execute external purchases, transfers, or payments.
- Use Cairo dates. Show income, purchases, and expenses separately; do not claim net profit without supported inventory accounting.
- Preserve user facts with provenance and keep confirmed facts distinct from proposals and assumptions.
- Use clear Egyptian Arabic. Never claim an action succeeded before its result is validated and committed.
- Keep voice optional. Text chat remains usable if browser speech or Gemini TTS is unavailable.
- Keep secrets in `.env`; do not expose them in browser code, logs, tests, or committed files.
- Preserve the SQLite database and verified backup. Use additive, restart-safe migrations.

## Commands

- `npm start`: run Fahima.
- `npm run dev`: run with Node watch mode.
- `npm test`: run isolated automated tests.
- `npm run doctor`: inspect runtime and database configuration.
- `npm run test:live*`: optional provider checks that may consume quota.

Report checks run. Do not claim live provider success without a verified request.
