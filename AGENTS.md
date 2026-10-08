# AGENTS.md

## Project overview

fahima is a local-first Arabic business assistant built with Node.js, Express, SQLite, and browser speech APIs. The server is authoritative for project data, transactions, inventory, and reports. Gemini interprets ordinary in-scope user messages; it does not access the database directly.

## Project structure

- `server/index.js`: Express routes and request orchestration.
- `server/agent.js`: Gemini prompt, structured intent schema, and fallback/domain handling.
- `server/gemini-client.js`, `server/config.js`: Gemini provider client and configuration.
- `server/business.js`, `server/business-tools.js`, `server/finance.js`: project-scoped business rules, allowlisted reads, and financial calculations.
- `server/db.js`: SQLite schema and migrations.
- `public/`: Arabic interface, chat, browser speech, and report generation.
- `test/`: Node.js built-in tests.

## Implementation rules

- Keep all database access and writes on the server. Scope every business operation to the selected project.
- Treat Gemini output as untrusted structured input. Validate it and use only allowlisted operations. Clear user-stated project facts save automatically with provenance; hypotheses never overwrite actual facts. Require explicit confirmation before committing financial transactions or destructive changes.
- Keep replies in short, everyday Egyptian Arabic for users with little reading or financial experience. Ask at most one clear question per turn, explain unavoidable terms plainly, and repeat important amounts for confirmation.
- Extract every clearly stated sale, purchase, and expense in a multi-operation message. Keep each operation separate, ask for missing details one at a time, and commit the batch only after explicit confirmation.
- Use Cairo calendar dates for business transactions and reporting.
- Keep stored records as the source of truth for totals and inventory. Do not present revenue minus purchases/expenses as net profit unless cost of goods sold is actually known.
- Never put `GEMINI_API_KEY` or other secrets in browser code, logs, tests, or committed files. Read configuration from environment variables. Do not impose local Gemini usage caps; show a temporary unavailable message when Gemini itself rejects requests for quota.
- Preserve Arabic copy and right-to-left behavior in the interface. Browser speech recognition and speech synthesis are optional; text chat must remain usable when either API is unavailable.
- Avoid unrelated changes to SQLite data files, migrations, or generated artifacts.

## Commands

- `npm run dev`: start the development server with restart-on-change.
- `npm start`: start the server.
- `npm test`: run the project test suite.
- `npm run doctor`: inspect local runtime and configuration.

Use the checks relevant to a change and report which commands were run. Do not claim a live Gemini request succeeded unless it was actually verified with configured credentials.
