# Faheema — فهيمه

Faheema is an Arabic business assistant for micro and very small businesses. It stores project records and confirmed business facts in SQLite, uses deterministic server-side code for accounting and inventory calculations, and calls Gemini only when natural-language understanding is needed.

## Quick start

Requirements: Node.js 20 or later and a Gemini API key for free-form message understanding.

```powershell
npm install
npm run setup
```

Add your key to `.env`, then start the app:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Core deterministic records, reports, and summaries continue to work without a Gemini key.

## AI and voice architecture

```text
Microphone → Browser Speech Recognition (ar-EG) → shared /api/chat pipeline
            → local business tools or Gemini text model → visible response
            → Browser/System Speech Synthesis
```

Faheema does not intentionally send microphone audio to Gemini. Browser speech recognition is browser and platform dependent and may use a vendor service; it is not guaranteed to run offline. If speech recognition or speech synthesis is unavailable, text chat remains usable. Speech synthesis prefers an Egyptian Arabic system voice, then another Arabic voice, then the system default.

## Memory and business data

- **Business memory:** SQLite project profile, confirmed project facts (with their source), products, inventory, transactions, and reminders. Facts are project scoped; financial entries remain in dedicated tables.
- **Conversation memory:** messages belong to a conversation, which belongs to one project. The API verifies that association before loading or changing it.
- **Working context:** recent messages and a compact deterministic conversation summary are combined with a small set of relevant business facts. Older messages are compacted locally after a threshold; summarization does not make another Gemini request. The current user message is preserved within its input limit.
- **Source of truth:** totals, product quantities, dates, and simple arithmetic are calculated from SQLite by server code. A memory summary never overrides stored records.

The current app is a local, single-user application without account authentication. The server binds to `127.0.0.1`; do not expose it directly to a network without adding authentication and user-level data scoping.

## Gemini and free-tier safeguards

The default model is `gemini-3.5-flash-lite`, configured centrally with `GEMINI_MODEL`. The identifier is confirmed in Google's [Gemini API model catalog](https://ai.google.dev/gemini-api/docs/models). Change the environment setting if the model is unavailable to your API project; the app does not silently switch models.

The SQLite-backed local quota guard tracks attempted generations, estimated input tokens, provider errors, and available usage metadata. Defaults reserve a safety margin: 15 RPM, 250,000 TPM, 500 RPD, a 450-request daily soft stop, and a 490-request hard ceiling. RPM and TPM also stop before their configured maximum. These are local safeguards, not authoritative Google quota data. Most eligible interactions make one Gemini generation; deterministic requests bypass Gemini. Only a temporary provider 429 may receive one bounded exponential-backoff retry with jitter (so that interaction can make two actual attempts); daily/quota 429 responses are not retried.

The model returns a constrained structured intent. The server validates and routes it through a project-scoped allowlisted business-tool registry (`get_sales_summary`, `get_project_summary`, `get_inventory`, `get_product_sales`, and `estimate_price`). Write actions continue through the confirmation workflow. The model cannot choose project IDs for tools, and there is no model/tool loop.

## Environment

Copy `.env.example` to `.env` (the setup script can create it) and set:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Server-side Gemini key. Never put this in browser code. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Configurable text model. |
| `GEMINI_MAX_RPM` | `15` | Provider request-per-minute ceiling used by the local guard. |
| `GEMINI_MAX_TPM` | `250000` | Provider estimated-token-per-minute ceiling. |
| `GEMINI_MAX_RPD` | `500` | Provider request-per-day ceiling. |
| `GEMINI_DAILY_SOFT_LIMIT` | `450` | Daily local stop that reserves provider headroom. |
| `GEMINI_DAILY_HARD_LIMIT` | `490` | Absolute local request ceiling. |
| `GEMINI_TIMEOUT_MS` | `30000` | Gemini request timeout. |
| `AGENT_RECENT_MESSAGE_LIMIT` | `8` | Recent messages considered for context. |
| `AGENT_CONTEXT_TOKEN_BUDGET` | `6000` | Approximate maximum working-context size. |
| `PORT` | `3000` | Local server port. |
| `DB_PATH` | `./data/fahim.sqlite` | Existing SQLite database path. |

## Data and accounting limits

Transactions are recorded only after conversational confirmation. Purchases and operating expenses are separate. The difference between sales and purchases/expenses is not labeled net profit because purchases can remain in inventory and cost of goods sold may be unknown. Project facts are confirmed before they become persistent memory.

## Tests

```powershell
npm test
```

The app keeps its SQLite database locally under `data/`; schema upgrades are additive and do not reset project or conversation records.
