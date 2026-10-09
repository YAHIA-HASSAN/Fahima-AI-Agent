# fahima (فهيمة)

fahima is a local-first, Arabic conversational business assistant for micro and very small businesses. Owners can record sales, purchases, operating expenses, and household withdrawals; ask about recorded activity; and manage basic project information, confirmed project facts, products, stock, reminders, and reports.

The MVP focuses on making business records easy to enter and understand. It is not a full accounting system: it keeps sales, purchases, and expenses distinct and does not label their difference as net profit. A purchase may still be in stock, and cost of goods sold is not necessarily known.

## What it does

- Conversational chat in Egyptian Arabic, with a text composer, optional browser speech input, and direct streamed Gemini audio replies.
- Automatic persistence of clear project facts, with confirmation before financial transactions; multiple clear operations in one message can be reviewed and confirmed together.
- Multiple projects, each with separate conversations, confirmed facts, transactions, products, stock, and reminders.
- Deterministic summaries and reports calculated from SQLite records.
- A lightweight PDF report flow from the interface.
- Gemini-powered intent extraction for free-form messages when GEMINI_API_KEY is configured; requests without a key receive a clear error instead of a misleading local guess.
- On-demand Google Search grounding for material prices, suppliers, requirements, and regulations, with cited sources and project-scoped freshness records.
- Gemini enforces its own usage limits; when Gemini reports a limit, fahima tells the user it is temporarily unavailable.

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

Open `.env` and add your Gemini and Serper keys:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
SERPER_API_KEY=your_serper_api_key
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
`npm run test:live-serper` performs one optional Serper market search only when `FAHIMA_LIVE_SERPER=1` and `SERPER_API_KEY` are configured.

## Configuration

`.env` contains machine-specific settings and secrets; keep it private and do not commit it. `.env.example` documents the supported settings and safe defaults. Copy it to `.env` when setting up a fresh checkout.

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Server-side key for Gemini. Never expose it in frontend code. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini text model used for intent extraction. |
| `GEMINI_SEARCH_MODEL` | same as `GEMINI_MODEL` | Optional separate Gemini model for Google Grounding when `SEARCH_PROVIDER=gemini`. |
| `SERPER_API_KEY` | empty | Server-side Serper search key. Never expose it in frontend code. |
| `SEARCH_PROVIDER` | `serper` | Primary market-research provider (`serper` or `gemini`). |
| `SEARCH_FALLBACK_PROVIDER` | empty | Optional Gemini Grounding fallback after Serper errors. |
| `SEARCH_CACHE_TTL_MS` | `600000` | Project-scoped in-memory cache duration for repeated market searches. |
| `GEMINI_TIMEOUT_MS` | `15000` | Gemini request timeout. Restart the server after changing `.env`, including the API key. |
| `GEMINI_TTS_TIMEOUT_MS` | `8000` | Maximum wait for Gemini audio before keeping the written reply available. |
| `GEMINI_SEARCH_TIMEOUT_MS` | `45000` | Maximum wait for one market-research provider request. |
| `AGENT_TASK_TIMEOUT_MS` | `300000` | Maximum background task duration (10 seconds to 5 minutes). |
| `AGENT_TASK_LEASE_MS` | `30000` | Worker lease duration before interrupted work can be reclaimed. |
| `GEMINI_INPUT_COST_PER_MILLION` | `0` | Optional input token price in your account currency; leave zero if unknown. |
| `GEMINI_OUTPUT_COST_PER_MILLION` | `0` | Optional output token price in your account currency; leave zero if unknown. |
| `FAHIMA_DIAGNOSTICS` | `1` | Structured lifecycle logs without message text or secrets. Set to `0` to silence them. |
| `AGENT_RECENT_MESSAGE_LIMIT` | `8` | Recent conversation messages included in agent context. |
| `AGENT_CONTEXT_TOKEN_BUDGET` | `6000` | Approximate working-context budget. |
| `PORT` | `3000` | HTTP server port. |
| `DB_PATH` | `./data/fahima.sqlite` | SQLite database file path. If this variable is absent and only the legacy `fahim.sqlite` file exists, fahima opens it automatically so existing data is preserved. |

Gemini controls the actual service quota. fahima does not impose an additional local request or daily-use quota. When Gemini returns HTTP 429, the assistant responds that it is temporarily unavailable.

## Architecture

```text
Browser UI (public/)
  ├─ Text chat
  ├─ Optional browser SpeechRecognition → Arabic transcript
  └─ Gemini TTS PCM chunks → progressive Web Audio playback
             │ JSON over same-origin HTTP
             ▼
Express API (server/index.js)
  ├─ Project and conversation scope checks
  ├─ Confirmation workflow for write operations
  ├─ Agent orchestration (server/agent.js)
  │    ├─ Gemini structured intent extraction and response validation
  │    └─ Grounded Google Search only when current external data affects the decision
  ├─ Allowlisted business tools (server/business-tools.js)
  ├─ Business operations and context (server/business.js)
  └─ Finance/date logic (server/finance.js)
             │ parameterized SQL
             ▼
       SQLite (data/)
```

### Agent and business logic

The model helps interpret language and return a constrained intent. It does not receive direct database access and cannot choose a project scope. For multi-step planning, the server runs a bounded task cycle: model decision → allowlisted research or deterministic calculation → validated tool result → next decision. The server owns project scope, validates each decision, and independently checks plan completion.

Clear user-stated facts save automatically with source and certainty metadata. Completed financial transactions are staged for confirmation. Proposed purchases stay in versioned plans and never enter the ledger. Business summaries are calculated from stored records rather than generated by the model. The app deliberately avoids claiming a net profit without the cost-of-goods information needed to support that calculation.

### Business data and write paths

Product names, units, quantities, amounts, activities, and project facts come from user messages interpreted by Gemini. There is no product dictionary, seeded business example, or local financial-language parser. The server supplies current project records as context and checks the returned types, allowed intents, amounts, and dates. Missing quantities or units are never replaced with invented business values.

The flow is **message → scoped context → validated Gemini interpretation → automatic factual memory → deterministic tools → advice and persistent next step**. Actual financial writes additionally go through pending review and explicit confirmation. The profile panel shows the current objective, goals, plan and progress instead of a fixed questionnaire. Memory edits are submitted through chat. Old direct business-write endpoints return 403; confirmation endpoints cannot replace the reviewed payload with client-supplied changes. Project creation/selection, deletion controls, and marking a reminder complete remain explicit interface management actions.

Confirmed purchase totals are preserved even when a per-unit cost is a repeating decimal. A purchase with only a total is recorded financially without creating a stock quantity. New itemized purchases and their stock movements are saved atomically. Existing records are not rewritten by this change.

UI text, transaction categories, schema constraints, date rules, arithmetic constants, and configurable runtime defaults are application rules, not business records. Example values in `test/` are isolated test fixtures. Tests use temporary SQLite databases and a mocked Gemini client; they do not verify live model accuracy.

### Adaptive advisor

One structured Gemini request interprets each ordinary message. It can extract several facts, revise a goal, select calculations, propose a plan, and choose one relevant question in the same turn. It receives a compact project context, not just recent messages. Narrow instruction-override checks remain local; ordinary business scope is interpreted by the model so unfamiliar activities are not rejected by a category keyword list.

- `server/advisor-schema.js`: bounded facts, provenance, goals, questions, planning state, proposals and numeric operands.
- `server/memory.js`: scoped current facts and revision history, goals, active objective, interrupted work, and plan versions. Hypotheses do not replace actual facts. Ambiguous conflicting values require clarification. Price observations retain source, date and certainty.
- `server/planning.js`: budget allocation, affordable quantities after reserve, revenue, unit contribution, cost coverage, goal comparisons and cash from a dated opening balance. Missing operands remain missing. Assumptions are labelled. Starting capital is not treated as current cash.
- `server/advisor.js`: applies clear facts and goals, executes the allowlisted scenario tool, maintains state and saves draft plans. Corrections invalidate old plans; stored calculation requests can be recalculated locally while the practical strategy remains marked for review.
- `server/market-research.js`: uses Gemini Google Search grounding and URL context, accepts only cited numeric offers for calculations, and retains source, unit, location, confidence, retrieval time, and expiry metadata.
- `server/response-quality.js`: translates known internal labels, suppresses repeated questions about known facts, rejects exposed syntax, unsupported numeric currency claims and obvious guarantees, and constructs arithmetic summaries from tool results. A failed check uses a safe local response, without a second provider call.

Schema versions 3 through 7 add metadata to existing facts, fact history, project goals, advisor state, versioned plans, project-scoped market research, durable agent tasks and steps, task metrics, plan change reasons, and planned-versus-actual outcomes. Existing records remain in place. Tasks use expiring leases, recover queued or expired work on server startup, cache completed step results, and deliver a result message once. Completed message identities are retained so retries after a restart do not count a transaction twice. Financial writes still require explicit confirmation.

Market research uses the existing Gemini provider and only runs when the model identifies a material missing or stale external fact. It first checks user prices and saved fresh research. A missing search runs after the main reply and reports its result through a project-scoped Server-Sent Events stream, so a slow provider does not keep the chat on “thinking.” Job state is stored in SQLite; the browser can recover the terminal result through a status endpoint if the event stream disconnects. Each provider request has a bounded timeout and ends with either a sourced result or an explicit conditional fallback. Grounded results are stored separately from user facts and transactions; expired results remain visible as stale history but are excluded from calculations. A cited online offer is still a planning input: availability, delivery, taxes, and local suitability need confirmation before purchase. Google may meter grounded searches under the configured Gemini account; fahima adds no separate search provider or dependency. See [Google's grounding guide](https://ai.google.dev/gemini-api/docs/google-search/) for provider behavior and pricing notes.

Direct requests such as “احسب وقولي” and “وريني حسابات الشهر ده” must select an executable calculation, search, plan, or report path. The server rejects a generated promise to act when no action was actually selected. Follow-ups can read the latest task or research state for the current project and conversation. Planning tasks return quickly with an ID and stream progress and the final result through SSE; the browser reattaches after a disconnect. Simple chat remains synchronous. Task limits are per task, not daily quotas: simple (2 decisions/2 tools/8k tokens), multi-step (4/4/16k), and business plans (6/6/24k), with a configurable maximum duration up to five minutes. Optional input/output token prices enable per-task cost estimates; without configured prices, the app reports token use and does not invent a monetary cost. Gemini 429 responses honor `Retry-After` and retry at most once.

Plans are stored as project-scoped revisions with assumptions, research references, calculations, risks, and steps. Validation distinguishes complete, provisional, and waiting-for-input plans; a model's own completion claim is not enough. Fresh prices must have a source, HTTPS URL, product/specification and unit match, location where requested, and an observation date within 30 days. Older prices remain visible as stale history and are excluded from calculations. Project facts and transaction changes mark plans stale. The task compares project inputs before and after work to avoid presenting a result based on outdated data. Subsequent plan discussion uses the saved plan and records revisions and change reasons. Confirmed transaction outcomes can be compared with plan proposals within the same project.

Agent status and quality metrics are available through project-scoped `/api/agent-tasks`, `/api/agent-tasks/:id`, `/api/agent-tasks/:id/events`, and `/api/agent-metrics` endpoints. Metrics include completion state, repeated questions, tool success and duration, plan validation gaps, task recovery, elapsed time, and token use. Automated tests mock Gemini and search; optional live evaluation requires a configured key and must be assessed separately.

The voice reply summarizes the advice; the plan panel displays detailed assumptions, steps, risks and calculations. Each chat response includes a short-lived Gemini stream URL, so the browser starts the request immediately and schedules each raw PCM chunk through Web Audio as it arrives instead of waiting for a complete audio file. Audio generation never disables text input, and failure still leaves the text response available.

See [manual advisor evaluation](docs/advisor-evaluation.md) for the representative conversation checks and the distinction between mocked tests and live model evaluation.

### Memory and persistence

- **Project memory:** project profile fields, confirmed facts, products, stock movements, transactions, and reminders are stored in SQLite and scoped to their project.
- **Conversation memory:** messages and pending actions belong to a conversation scoped to a project. Recent messages plus a compact local summary form the working context.
- **Data authority:** SQLite records are the source of truth for totals and stock. Conversation context helps understand follow-ups; it does not override records.
- **Project deletion:** deleting a project also deletes its related project data. The UI asks for confirmation and the API preserves at least one project.

### Voice and privacy

Voice input uses browser speech recognition. Output comes directly from Gemini as a progressive PCM stream:

```text
Microphone → browser SpeechRecognition (ar-EG where available)
           → transcript → existing /api/chat pipeline
           → text response + one-use stream URL
           → Gemini TTS → PCM chunks → Web Audio playback
```

fahima does not send microphone audio to Gemini: browser speech recognition converts it to text first. For output, the server creates a short-lived one-use URL and forwards Gemini 24 kHz, mono, 16-bit PCM chunks as they arrive. The browser converts each chunk to a Web Audio buffer and schedules it immediately. Gemini TTS requires a configured key and available quota. Browser speech recognition depends on the browser and operating system and may use the browser vendor's service, so it is not guaranteed to be offline.

## Project structure

```text
server/
  index.js          Express app, API routes, orchestration, request validation
  agent.js          Adaptive prompt, validated Gemini interpretation, bounded context
  advisor*.js       Advisory orchestration and structured output schema
  memory.js         Factual memory, goals, state and plan revisions
  planning.js       Deterministic scenario arithmetic
  response-quality.js Language and response guards
  market-research.js Grounded web research, citation checks, freshness metadata
  research-jobs.js Legacy non-blocking research compatibility
  agent-tasks.js Durable task leases, recovery, idempotent steps and SSE
  agent-task-runner.js Bounded decision/tool cycles and completion checks
  plan-validator.js Deterministic plan completeness validation
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
  fahima.sqlite     Local application database for a new setup
  fahim.sqlite      Legacy filename, opened automatically when it is the existing database
```

## Security and deployment notes

This is a local, single-user application without login or account-level authorization. The server binds to `127.0.0.1`. Do not expose it directly to a LAN or the public internet without adding authentication, authorization, CSRF protections as appropriate, and user-level data isolation. Keep `.env` private and back up the SQLite database if its records matter.

## Current scope

fahima is an MVP, not a complete accounting or inventory platform. It does not calculate final net profit or guarantee browser speech recognition or Gemini audio availability. Online prices are temporary cited planning inputs rather than confirmed availability or purchase quotes. Reports and answers reflect stored project data, confirmed transactions, explicit assumptions, and any displayed research sources.
