# Faheema (فهيمه)

Faheema is a local-first, Arabic conversational business assistant for micro and very small businesses. Owners can record sales, purchases, operating expenses, and household withdrawals; ask about recorded activity; and manage basic project information, confirmed project facts, products, stock, reminders, and reports.

The MVP focuses on making business records easy to enter and understand. It is not a full accounting system: it keeps sales, purchases, and expenses distinct and does not label their difference as net profit. A purchase may still be in stock, and cost of goods sold is not necessarily known.

## What it does

- Conversational chat in Egyptian Arabic, with a text composer and optional browser speech input and Gemini audio replies.
- A confirmation step before a transaction or a newly suggested project fact is saved; multiple clear operations in one message can be reviewed and confirmed together.
- Multiple projects, each with separate conversations, confirmed facts, transactions, products, stock, and reminders.
- Deterministic summaries and reports calculated from SQLite records.
- A lightweight PDF report flow from the interface.
- Gemini-powered intent extraction for free-form messages when GEMINI_API_KEY is configured; requests without a key receive a clear error instead of a misleading local guess.
- Gemini enforces its own usage limits; when Gemini reports a limit, Faheema tells the user it is temporarily unavailable.

## Requirements

-  [Node.js](https://nodejs.org/en/download) 20 or later (npm is included with Node.js). 
- Windows, macOS, or Linux.
- A Gemini API key for understanding text or voice messages and proposing business writes. Stored data and reports remain readable without Gemini; failed model requests never trigger guessed financial entries.
- A modern browser. Speech recognition availability depends on the browser and operating system.

## Run locally

From the project directory:

```powershell
npm install
npm run setup
```

`npm run setup` creates `.env` from `.env.example` if needed and initializes the local SQLite database. It does not overwrite an existing `.env`.

Open `.env` and add your Gemini key:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
```

Then start the development server:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and create a project with a name you choose. A fresh database has no seeded projects or business records. To run without automatic restarts, use `npm start`.

Useful maintenance commands:

```powershell
npm test
npm run doctor
```

`npm run doctor -- --check-gemini` also makes one optional Gemini connectivity request. It requires a configured key and network access.

## Configuration

`.env` contains machine-specific settings and secrets; keep it private and do not commit it. `.env.example` documents the supported settings and safe defaults. Copy it to `.env` when setting up a fresh checkout.

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Server-side key for Gemini. Never expose it in frontend code. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini text model used for intent extraction. |
| `GEMINI_TIMEOUT_MS` | `15000` | Gemini request timeout. Restart the server after changing `.env`, including the API key. |
| `AGENT_RECENT_MESSAGE_LIMIT` | `8` | Recent conversation messages included in agent context. |
| `AGENT_CONTEXT_TOKEN_BUDGET` | `6000` | Approximate working-context budget. |
| `PORT` | `3000` | HTTP server port. |
| `DB_PATH` | `./data/fahim.sqlite` | SQLite database file path. |

Gemini controls the actual service quota. Faheema does not impose an additional local request or daily-use quota. When Gemini returns HTTP 429, the assistant responds that it is temporarily unavailable.

## Architecture

```text
Browser UI (public/)
  ├─ Text chat
  ├─ Optional browser SpeechRecognition → Arabic transcript
  └─ Gemini TTS WAV → browser audio playback
             │ JSON over same-origin HTTP
             ▼
Express API (server/index.js)
  ├─ Project and conversation scope checks
  ├─ Confirmation workflow for write operations
  ├─ Agent orchestration (server/agent.js)
  │    ├─ Gemini structured intent extraction and response validation
  │    └─ Explicit confirmation/cancellation of staged data
  ├─ Allowlisted business tools (server/business-tools.js)
  ├─ Business operations and context (server/business.js)
  └─ Finance/date logic (server/finance.js)
             │ parameterized SQL
             ▼
       SQLite (data/)
```

### Agent and business logic

The model helps interpret language and return a constrained intent. It does not receive direct database access and cannot choose a project scope. The server validates the intent, supplies the selected project ID to an allowlisted tool registry, and performs calculations using application code and SQLite. There is no open-ended model/tool execution loop.

Write actions are staged for user confirmation before they are committed. Business summaries are calculated from stored records rather than generated by the model. The app deliberately avoids claiming a net profit without the cost-of-goods information needed to support that calculation.

### Business data and write paths

Product names, units, quantities, amounts, activities, and project facts come from user messages interpreted by Gemini. There is no product dictionary, seeded business example, or local financial-language parser. The server supplies current project records as context and checks the returned types, allowed intents, amounts, and dates. Missing quantities or units are never replaced with invented business values.

The flow is **message → Gemini fields → server validation → pending review → explicit confirmation → SQLite**. Profile and memory forms also submit their contents through chat. Old direct business-write endpoints return 403; confirmation endpoints cannot replace the reviewed payload with client-supplied changes. Project creation/selection, deletion controls, and marking a reminder complete remain explicit interface management actions.

Confirmed purchase totals are preserved even when a per-unit cost is a repeating decimal. A purchase with only a total is recorded financially without creating a stock quantity. New itemized purchases and their stock movements are saved atomically. Existing records are not rewritten by this change.

UI text, transaction categories, schema constraints, date rules, arithmetic constants, and configurable runtime defaults are application rules, not business records. Example values in `test/` are isolated test fixtures. Tests use temporary SQLite databases and a mocked Gemini client; they do not verify live model accuracy.

### Memory and persistence

- **Project memory:** project profile fields, confirmed facts, products, stock movements, transactions, and reminders are stored in SQLite and scoped to their project.
- **Conversation memory:** messages and pending actions belong to a conversation scoped to a project. Recent messages plus a compact local summary form the working context.
- **Data authority:** SQLite records are the source of truth for totals and stock. Conversation context helps understand follow-ups; it does not override records.
- **Project deletion:** deleting a project also deletes its related project data. The UI asks for confirmation and the API preserves at least one project.

### Voice and privacy

Voice input uses browser speech recognition. The app automatically generates each reply as Gemini TTS audio and plays it in the browser:

```text
Microphone → browser SpeechRecognition (ar-EG where available)
           → transcript → existing /api/chat pipeline
           → text response → Gemini TTS → automatic browser audio playback
```

Faheema does not send microphone audio to Gemini: browser speech recognition converts it to text first. After each assistant reply, the reply text is sent to Gemini TTS using the server-side API key and the returned WAV is played by the browser. TTS requires a configured key and available Gemini service. The interface does not substitute a system voice when Gemini TTS fails, to avoid speaking Arabic replies with an unrelated language or voice. Browser speech recognition is browser/platform dependent and may use the browser vendor's service, so it is not guaranteed to be offline.

## Project structure

```text
server/
  index.js          Express app, API routes, orchestration, request validation
  agent.js          Intent schema, validated Gemini interpretation, context compaction
  business-tools.js Project-scoped allowlisted read tools
  business.js       Projects, conversations, facts, transactions, products, inventory
  finance.js        Date validation, number formatting, deterministic summaries
  gemini-client.js  Gemini SDK calls and structured response parsing
  config.js         Environment configuration and validation
  db.js             SQLite connection and additive schema migrations
public/
  index.html        Arabic single-page UI
  app.js            Browser chat, voice, projects, and report interactions
  *.css             Interface styles
scripts/
  setup.js          Create environment file and initialize SQLite
  doctor.js         Check runtime, dependencies, configuration, and database
test/
  finance.test.js
  agent-architecture.test.js
data/
  fahim.sqlite      Local application database (created during setup)
```

## Security and deployment notes

This is a local, single-user application without login or account-level authorization. The server binds to `127.0.0.1`. Do not expose it directly to a LAN or the public internet without adding authentication, authorization, CSRF protections as appropriate, and user-level data isolation. Keep `.env` private and back up the SQLite database if its records matter.

## Current scope

Faheema is an MVP, not a complete accounting or inventory platform. It does not calculate final net profit, provide market prices, or guarantee browser voice support. Reports and answers reflect only data entered and confirmed in the selected project.
