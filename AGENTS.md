# AGENTS.md

Operating manual for any coding agent working in Tusk. Product and technical truth live in `docs/`. This file is the **process** contract.

## Read first

1. [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is in-scope *right now*
2. [`docs/PRD.md`](docs/PRD.md) + the feature PRD for the module you touch
3. [`docs/TRD.md`](docs/TRD.md) — stack, schema rules, API, security
4. Matching skill under `.cursor/skills/` (schema, RLS, search, API, SQL, phase)

Do not implement from memory of the original brainstorm. If a PRD/TRD/roadmap disagree, **stop and flag the conflict**. Do not silently pick a side.

## Mission

Build a Postgres-only Fastify REST API. Every major capability (geo, FTS, vectors, JSONB, RLS, unlogged cache, MVs, cron, partitions) must exist because the product needs it — not as a demo island.

## Hard rules

- **Postgres-only.** No Redis, Elasticsearch, vector DBs, Mongo, Kafka-as-source-of-truth, Bull/Redis queues as system of record.
- **No Prisma** (or schema-hiding ORMs). `postgres.js` + SQL files.
- **No GraphQL / tRPC / NestJS.** Fastify REST `/v1`.
- **No frontend** until roadmap says so.
- **RLS is isolation.** App always opens a transaction and `SET LOCAL` (`set_config(..., true)`) for `app.tenant_id`, `app.user_id`, `app.role` before queries. Do not “just add `WHERE tenant_id = $1`” as the security model.
- **Phase discipline.** Finish the current phase’s exit criteria before starting the next. Do not scaffold Phase 7 observability while Phase 1 RLS is incomplete.
- **No secrets in git.** `.env` stays local; `.env.example` has names only.
- **Do not commit** unless the user asks.
- **No Cursor attribution.** Never add `Co-authored-by: Cursor <cursoragent@cursor.com>`, `Made-with: Cursor`, or similar trailers to commits or PRs.

## Phase execution

Use the **tusk-phase** skill. Work loop:

1. Identify the lowest incomplete phase in `docs/ROADMAP.md`.
2. Implement only checklist items in that phase (plus bugfixes in already-shipped phases).
3. Tick checkboxes in the roadmap when an item is actually done (code + tests), not when planned.
4. Stop at exit criteria. Summarize remaining boxes; do not skip ahead.

## Code conventions

| Area | Rule |
|------|------|
| IDs | UUIDv7 generated in DB (`uuidv7()` or equivalent extension/function agreed in Phase 1) |
| SQL names | `snake_case` tables/columns |
| JSON | `camelCase` |
| Time | `timestamptz` only, store UTC |
| Money | integer **minor units** + `currency char(3)` — no `float` |
| Errors | stable `error.code` strings from TRD; HTTP status per table |
| Pagination | cursor `(created_at, id)` — no offset pagination on large lists |
| Validation | Fastify schema on every route; never trust body/query without it |
| Transactions | one request that writes **or** uses RLS → one `sql.begin` |
| Embeddings | Node calls provider; DB stores `vector(N)` only |

## SQL

- Prefer named SQL files or tagged templates colocated with the module (`src/modules/<name>/*.sql.ts`).
- Every new hot query needs `EXPLAIN (ANALYZE, BUFFERS)` captured when we have a `docs/perf/` folder (Phase 5+). Until then, still add the supporting index in the same migration as the query.
- `UNLOGGED` only for data that may vanish; always implement a rebuild path from logged tables.
- Extensions are created in migrations, not by hand on a laptop only.

## Testing

- Integration tests against **real** Postgres (Testcontainers or Compose). Do not mock the database for RLS, search, or booking tests.
- Minimum for isolation: tenant A cannot `SELECT` tenant B’s rows with a stolen UUID.
- Minimum for bookings: two concurrent bookings cannot exceed capacity.

## Subagents

Use project subagents in `.cursor/agents/` when the task matches:

| Agent | Use for |
|-------|---------|
| `postgres-architect` | Tables, indexes, extensions, constraints, partitions |
| `search-engineer` | Hybrid ranking, FTS, HNSW, embeddings pipeline |
| `rls-auditor` | Policies, FORCE RLS, BYPASSRLS, SET LOCAL |
| `sql-performance` | EXPLAIN, indexes, MV, unlogged, vacuum |
| `api-reviewer` | REST shape, envelopes, status codes, idempotency |

Do not delegate “build the whole app” to a subagent. Delegate a bounded review or design.

## Out of scope unless roadmap says so

Kubernetes, logical replication, Prometheus dashboards, Next.js, maps UI, real payment capture, PL/Python, PgBouncer (before Phase 7), `LISTEN/NOTIFY` (before Phase 7).
