# Runtime flow

```text
HTTP chat / recognized speech
  → agent.run (scope check, request idempotency, persist user message + task)
  → orchestrator (lease, recovery, budgets, delivery)
  → agent loop
      → Gemini function-calling decision
      → tool registry (schema + project permission checks)
      → domain service (SQLite, arithmetic, Serper, plan validator)
      → durable observation
      → Gemini receives observation and decides again
  → validated task result + one assistant message
  → UI polls task and renders active plan revision
```

The code stores action names and tool outcomes, not private chain-of-thought. Existing SQLite project and transaction tables remain the source for those records. Agent state uses additive `fahima_v2_*` tables. No database rows are migrated or removed by application startup.
