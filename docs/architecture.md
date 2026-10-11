# Runtime flow

```text
HTTP chat / recognized speech
  → agent.run (scope check, request idempotency, persist user message + task)
  → orchestrator (lease, recovery, budgets, delivery)
  → agent loop
      → Gemini function-calling decision
      → tool registry (schema + project permission checks)
      → domain service (SQLite, arithmetic, Serper, reporting)
      → durable observation
      → Gemini receives observation and decides again
  → validated task result + one assistant message
  → UI polls task and renders the answer; any previously saved plan remains read-only
```

The code stores action names and tool outcomes, not private chain-of-thought. Existing SQLite project and transaction tables remain the source for those records. Agent state uses additive `fahima_v2_*` tables. No database rows are migrated or removed by application startup.

The agent can search the web with `search_market`, but it does not create, calculate, revise, or persist project plans. Existing saved plans remain available through the project read APIs so user data is preserved.
