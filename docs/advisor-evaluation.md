# Evaluating the adaptive fahima advisor

## Running

Use the existing Node.js installation and dependencies. `npm test` uses temporary SQLite databases and mocked Gemini and search responses; it does not call the provider. `npm run dev` starts the application with the configured Gemini model, grounded search, and audio settings. Schema migrations run automatically on the selected database without deleting existing records.

For a separate manual evaluation database in PowerShell:

```powershell
$env:DB_PATH = './data/fahima-evaluation.sqlite'
npm run dev
```

Use the existing server-side `GEMINI_API_KEY` configuration. Never paste a key into chat or browser code. Create distinct evaluation projects through the interface. After testing, stop the server and remove the temporary `DB_PATH` override to resume using the normal database.

## Representative conversations

| Check | Messages / setup | Expected behavior |
| --- | --- | --- |
| Automatic facts | «معايا 10 آلاف جنيه وعايز أعمل مشروع دواجن وعندي أوضة فاضية» | Capital, activity and available space save without routine confirmation; reply considers prerequisites rather than immediately buying. |
| Recall | Later: «قسملي الفلوس على المشروع» | Uses stored capital; budget arithmetic comes from the server; proposed allocation and reserve are labelled. |
| Same industry | Separate new, operating and closed poultry projects with different budgets and resources | Different objectives and plans; no transfer of facts or capital. |
| Other industries | Tailoring, grocery retail, home food and an unfamiliar service | Relevant advice without a poultry question template. |
| Existing business | «عندي محل بقالة بس مش عارف الفلوس بتروح فين» | Focuses on recorded sales, purchases, expenses and missing records rather than a startup questionnaire. |
| Unknown prices | «معرفش سعر العلف، دوري على سعر حديث» | Searches only if the price materially affects the next step; shows sources, location and review date; rejects uncited or unitless prices from calculations. |
| Research freshness | Repeat a price-dependent request before and after the stored result expires | Reuses fresh project research, marks old results stale, and searches again when needed. |
| Goals | «عايز أكسب 5000 جنيه شهريًا» | Goal and horizon persist; feasibility is conditional on known costs and demand; no guarantee. |
| Switch | «نروح مشروع محل» where that exact project name exists | Resolves a unique database name; updates the selected project without moving any records. Ambiguous names require selection. |
| Planned / actual | «هشتري 50 كتكوت» then «اشتريت 50 كتكوت بخمسمية» | First is a proposal; second requests financial review. Mixed messages retain separate proposed and completed operations. |
| Interrupt / resume | Ask a related price question during planning, then «طيب كمل الخطة» | Restores the objective and existing plan rather than restarting discovery. |
| Language | Read advice, question, fact labels and plan details | Everyday Egyptian Arabic; one useful question; no internal keys or tool syntax. Real product names remain intact. |
| Restart | Stop and restart the server, reopen the project | Facts, goals, plan versions and active objective are retrieved from SQLite. |
| Correction | «لا، خلي رأس المال 12 ألف» | Replaces the active fact, retains its history, flags old strategy for review, and recalculates stored arithmetic where applicable. |
| Hypothetical | «لو كان معايا 50 ألف بدل 12 ألف، أقدر أعمل إيه؟» | Discusses a scenario without overwriting actual capital. |
| Frustration | «قولتلك معايا 12 ألف! إنت بتسأل تاني ليه؟» | Uses the known value and continues constructively. |
| Duplicate voice identity | Replay a chat request and its confirmation with the same `requestId` | Cached result, no duplicate transaction, including after restart. A different message using that identity is rejected. |
| Durable plan task | «معايا 10 آلاف جنيه وعايز أبدأ مشروع دواجن» | Chat responds promptly with task status; progress and final result are recoverable after reconnect or server restart. Plan is stored as complete or provisional with missing inputs shown. |
| Plan discussion | After a plan: «ليه اخترتي العدد ده؟» then «زودي رأس المال لـ 15 ألف» | Answer references saved plan context; a material correction creates a revision and marks affected strategy for review. |
| Stale research | Reuse a saved price with an observation date more than 30 days old | Price stays in research history but is excluded from confirmed calculation inputs. |
| Quality metrics | Request `/api/agent-metrics` with a selected project | Returns only that project's task and plan outcome metrics; no records from another project are included. |

## Automated coverage and limits

The tests exercise real Express routes, schema validation, SQLite writes, migrations, tool calculations, plan revisions, project isolation, interruptions, expired-lease recovery, task idempotency, plan validation, and reloads. Provider fixtures represent different interpretations of the example messages; they do **not** establish that the configured live model always interprets them correctly. Inspect actual model behavior with the conversation checks above. The suite also verifies prompt return and task follow-up using mocked providers, not actual Gemini latency or search quality.

Response checks catch known internal terms, exposed syntax, some unsupported numeric claims, duplicate questions and obvious guarantees. They are lightweight safeguards, not a complete semantic or safety verifier. Specialist recommendations, spoken-language understanding, long conversations, unfamiliar names, real browser audio, and live supplier availability still require manual evaluation. Automated tests mock grounded search; use a configured Gemini key for the live research check and verify every displayed source page, unit, location, and retrieval date.

UI project creation/deletion, explicit fact deletion and reminder completion remain direct user actions. Financial writes still require review. A side question preserves a pending financial operation, but a later bare «أيوه» first shows its review again so it cannot accidentally confirm a different question.
