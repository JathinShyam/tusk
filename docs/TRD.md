# Tusk — Technical Requirements Document

**Version:** 1.0  
**Status:** Binding for implementation  
**Related:** [PRD](PRD.md) · [Roadmap](ROADMAP.md)

---

## 1. Purpose

Specify architecture, data, API, security, performance, and operations for the Tusk API so implementation does not reinvent stack or isolation.

## 2. System context

- **In scope:** Fastify REST API, PostgreSQL 16+ with listed extensions, Docker Compose, migrations, integration tests.
- **Out of scope until named phase:** Kubernetes, frontend, PgBouncer (Phase 7), logical replication (Phase 8), email provider (digest may persist rows only).

```
[HTTPS clients] → Fastify :3000 → postgres.js pool → PostgreSQL :5432
                                      ↑
                               pg_cron (inside DB)
```

## 3. Constraints (binding)

| ID | Constraint |
|----|------------|
| TR-C-001 | System of record is PostgreSQL. No other database or cache product. |
| TR-C-002 | SQL is explicit. Forbidden: Prisma, Sequelize, TypeORM, Drizzle-as-schema-source-of-truth. Query builders that emit visible SQL are allowed only if raw SQL remains the default. |
| TR-C-003 | HTTP is REST `/v1/*` only. No GraphQL, tRPC, WebSocket-first API (LISTEN/NOTIFY is server-side; optional SSE later). |
| TR-C-004 | Framework is Fastify 5 + TypeScript strict. Not Nest, Express, Hono. |
| TR-C-005 | Embeddings: application process calls provider; DB stores vectors. No PL/Python model inference in v1. |
| TR-C-006 | Jobs that must run on a schedule are `pg_cron`. App may run request-time workers (embed on write). |
| TR-C-007 | `FORCE ROW LEVEL SECURITY` on all tenant tables. Superuser/migration role is the only BYPASSRLS. |
| TR-C-008 | Connection pool must remain PgBouncer-transaction-mode compatible: no session-level `SET` that must survive a request; use `SET LOCAL` / `set_config(..., true)`. |

## 4. Tech stack

| Component | Requirement |
|-----------|-------------|
| Node.js | 22 LTS |
| Package manager | pnpm |
| Fastify | 5.x |
| postgres.js | 3.x, one pool per process |
| Validation | One library for the repo: TypeBox **or** Zod (decision in Phase 0; TypeBox preferred with Fastify) |
| Migrations | node-pg-migrate, SQL migrations in repo |
| Postgres image | Official image + PostGIS; install pgvector, pg_cron, pg_stat_statements, pg_trgm; pg_partman from Phase 6 |
| Auth tokens | Access JWT (short TTL, e.g. 15m) + refresh token **hashed** in `refresh_tokens` |
| IDs | UUIDv7 in database |
| Tests | Vitest + Testcontainers (or Compose service `postgres-test`) |
| Lint | oxlint or eslint — pick one in Phase 0 |

### 4.1 Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | App role DSN (RLS applies) |
| `DATABASE_MIGRATE_URL` | Owner/migration role DSN |
| `JWT_ACCESS_SECRET` | Access token HMAC or private key ref |
| `JWT_REFRESH_SECRET` | Separate secret |
| `EMBEDDING_PROVIDER` | `openai` \| `voyage` \| `mock` |
| `EMBEDDING_API_KEY` | Provider key (empty if mock) |
| `EMBEDDING_DIM` | Must match column (`1536` default) |
| `LOG_LEVEL` | `info` default |

`mock` embeddings are deterministic unit vectors for tests/offline.

## 5. Process & roles in Postgres

| Role | Use |
|------|-----|
| `tusk_migrator` | DDL, `BYPASSRLS`, owned by compose init |
| `tusk_app` | DML via API; **no** BYPASSRLS; `SET ROLE` not required if DSN is this user |
| `tusk_cron` | Functions invoked by pg_cron; SECURITY DEFINER only where documented |

App role: `GRANT` table DML as needed; **no** `BYPASSRLS`. Default privileges documented in the identity migration.

## 6. Request pipeline (mandatory)

1. Validate JWT (except public auth + health).
2. Resolve `tenantId`, `userId`, `role` from token (role must match membership; do not trust role without DB check on sensitive writes — membership lookup in the same transaction is required for mutating routes).
3. `sql.begin`:
   - `select set_config('app.tenant_id', $tenant, true)`
   - `select set_config('app.user_id', $user, true)`
   - `select set_config('app.role', $role, true)`
   - optional `set local statement_timeout`
4. Execute queries.
5. Commit / rollback.

Policies read `current_setting('app.tenant_id', true)::uuid` (and role). Missing setting → no rows / insert fail.

## 7. Logical data model (required entities)

Minimum columns: `id uuid pk`, `tenant_id uuid not null`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`. Tenant tables also used by RLS.

| Table | Purpose | Notes |
|-------|---------|-------|
| `tenants` | SaaS tenant | `type`, `slug` unique, `settings jsonb`, `status` |
| `users` | Login identity | email unique **globally** or per-tenant — **per-tenant unique (tenant_id, lower(email))** so the same person can exist in two tenants as separate users **or** a global users table + memberships. **Decision: global `users` (email unique) + `memberships`.** |
| `memberships` | user–tenant–role | unique `(tenant_id, user_id)` |
| `refresh_tokens` | hashed refresh | revoke on rotation |
| `places` | POI / venue | `geog geography(Point,4326) not null`, `fts tsvector` generated, `embedding vector(N)`, `attrs jsonb` |
| `experiences` | Bookable offering | `place_id`, `host_user_id`, `fts`, `embedding`, `attrs jsonb`, `status` |
| `experience_slots` | Capacity windows | `during tstzrange`, `capacity int`, exclusion constraint |
| `bookings` | Reservation | `slot_id`, `user_id`, `status`, `version` (optimistic), `external_payment_id` |
| `reviews` | Content | `place_id` and/or `experience_id`, `body`, `payload jsonb`, `fts`, `embedding` |
| `itineraries` | Documents | `doc jsonb` (schema versioned in JSON) |
| `user_preferences` | Preference document | `doc jsonb`, `embedding` |
| `categories` | Hierarchy | `parent_id`, recursive CTE |
| `activity_events` | Feed + analytics | **partitioned by time** from Phase 6; until then unpartitioned is allowed |
| `audit_logs` | Security/audit | insert-only from triggers; partitioned Phase 6+ |
| `place_detail_cache` | UNLOGGED | rebuild from `places` + aggregates |
| `recommendation_cache` | UNLOGGED | keyed by `(tenant_id, user_id)` |
| `mv_trending_places` | Materialized view | unique index for `REFRESH CONCURRENTLY` |

Triggers: `updated_at` bump; audit on bookings status changes; optional notify on activity insert (Phase 7).

### 7.1 Indexes (minimum)

| Object | Index |
|--------|-------|
| `places.geog` | GiST |
| `places.fts` | GIN |
| `places.embedding` | HNSW (`vector_cosine_ops`) |
| `places.attrs` | GIN |
| `experiences` | same pattern as places where columns exist |
| `experience_slots.during` | GiST; **exclusion** `USING gist (experience_id WITH =, during WITH &&)` where overlapping slots are forbidden **or** explicit non-overlap rule documented |
| `bookings (slot_id)` | btree; unique active booking per (slot, user) |
| `reviews.payload` | GIN |
| Time-series | BRIN on `created_at` if not partitioned yet |

HNSW vs IVFFlat: **HNSW** for v1 (ADR in Phase 7). Lists/probes of IVFFlat not used unless we revisit.

### 7.2 Generated columns

- `fts` from `title`, `description`, and selected JSONB text via `to_tsvector('english', ...)`
- Optional `popularity_score` generated from counters **or** maintained by trigger — pick trigger if it depends on other tables

## 8. Hybrid search (query contract)

Single SQL statement (CTE allowed) for `GET /v1/search`:

1. Optional geo filter: `ST_DWithin(geog, origin, radius_m)`
2. Optional FTS: `fts @@ websearch_to_tsquery('english', q)` with `ts_rank_cd`
3. Optional semantic: `embedding <=> query_embedding` (cosine)
4. Combine with weights from `tenants.settings->'ranking'` or defaults in PRD/README
5. `LIMIT` + keyset pagination on `(score, id)` — scores must be stable enough for cursors or use `id` tie-break only

Empty `q` + geo only is valid (near-me). Empty `q` + no geo is invalid (`400`).

Embedding for the query is computed in Node, passed as a parameter. Do not call HTTP from SQL.

## 9. Booking concurrency (query contract)

**Invariant:** sum of active bookings for a slot ≤ `capacity`.

Required implementation (all of):

1. `INSERT` bookings in a transaction with `SET LOCAL` RLS.
2. `SELECT ... FROM experience_slots WHERE id = $id FOR UPDATE` (row lock) **or** `pg_advisory_xact_lock` on slot id.
3. Count active bookings; if `count + party_size > capacity` → rollback, HTTP `409` `BOOKING_CAPACITY`.
4. Optional: Postgres `EXCLUDE` / check constraint cannot easily express “sum ≤ capacity”; **do not** rely on unique-only. The lock + count is the source of truth.
5. Idempotency: `Idempotency-Key` header stored in `idempotency_keys` (tenant-scoped) for `POST` bookings.

Serializable isolation is **allowed** as an additional experiment; it is not required if row locks are correct. Document the choice in code comment + Phase 3 checklist.

## 10. REST API

### 10.1 Envelope

Success:

```json
{
  "data": {},
  "meta": {
    "requestId": "uuid",
    "pagination": { "nextCursor": "string|null" }
  }
}
```

`data` is an object or array. Never wrap twice.

Error:

```json
{
  "error": {
    "code": "BOOKING_CAPACITY",
    "message": "Human-readable, stable for that code",
    "details": {}
  },
  "meta": { "requestId": "uuid" }
}
```

### 10.2 HTTP mapping

| Situation | Status | `error.code` (examples) |
|-----------|--------|-------------------------|
| Validation | 400 | `VALIDATION` |
| Missing/invalid JWT | 401 | `UNAUTHENTICATED` |
| RLS/authz (known user, forbidden) | 403 | `FORBIDDEN` |
| Not found **or** hidden by RLS | 404 | `NOT_FOUND` |
| Overbook / slot conflict | 409 | `BOOKING_CAPACITY` / `BOOKING_CONFLICT` |
| Idempotency replay mismatch | 409 | `IDEMPOTENCY_CONFLICT` |
| Rate limit (if added) | 429 | `RATE_LIMITED` |
| Unhandled | 500 | `INTERNAL` |

Do not leak whether a UUID exists in another tenant (404).

### 10.3 Routes (normative list)

Public:

| Method | Path | Phase |
|--------|------|-------|
| GET | `/v1/health` | 0 |
| GET | `/v1/ready` | 0 (DB ping) |
| POST | `/v1/auth/register` | 1 |
| POST | `/v1/auth/login` | 1 |
| POST | `/v1/auth/refresh` | 1 |
| POST | `/v1/auth/logout` | 1 |

Authenticated (tenant in JWT):

| Method | Path | Phase |
|--------|------|-------|
| GET | `/v1/me` | 1 |
| GET/PATCH | `/v1/me/preferences` | 5 |
| GET | `/v1/places` | 2 |
| POST | `/v1/places` | 2 (host/admin) |
| GET | `/v1/places/:id` | 2 |
| GET | `/v1/experiences` | 3 |
| POST | `/v1/experiences` | 3 |
| GET | `/v1/experiences/:id` | 3 |
| GET/POST | `/v1/experiences/:id/slots` | 3 |
| POST | `/v1/experiences/:id/bookings` | 3 |
| GET | `/v1/bookings` | 3 |
| GET | `/v1/bookings/:id` | 3 |
| POST | `/v1/bookings/:id/cancel` | 3 |
| GET | `/v1/search` | 4 |
| GET | `/v1/recommendations` | 4 (naive) / 7 (full) |
| GET/POST | `/v1/reviews` | 5 |
| GET/POST | `/v1/itineraries` | 5 |
| GET | `/v1/feed` | 7 |
| GET | `/v1/digests/latest` | 6 |
| GET/PATCH | `/v1/admin/tenant` | 1+ (tenant admin) |

Admin platform routes (platform admin JWT): `POST /v1/platform/tenants` — Phase 1.

### 10.4 Query conventions

- Geo: `lat`, `lng`, `radiusM` (integer meters), optional `bbox=west,south,east,north`
- Search: `q`, plus geo params, `limit` (max 50, default 20)
- Filters: `category`, `attrs` as JSON object matching JSONB containment (`@>`)
- Cursors: opaque base64url of `{ t, id, score? }`

## 11. Security

| ID | Requirement |
|----|-------------|
| TR-SEC-001 | Passwords: Argon2id. Never log passwords or tokens. |
| TR-SEC-002 | Refresh tokens: store hash only; rotate on use; reuse detection revokes family. |
| TR-SEC-003 | RLS policies: tenant match AND role/ownership predicates. |
| TR-SEC-004 | `places`/`experiences` readable by all memberships of tenant if `status = 'published'`; drafts only by owner/admin. |
| TR-SEC-005 | SQL injection: only parameterized SQL. |
| TR-SEC-006 | CORS: explicit origins from env. |
| TR-SEC-007 | Headers: `requestId` on every response; no stack traces to clients. |
| TR-SEC-008 | Least privilege DB role for the app. |

## 12. Caching & durability

| ID | Requirement |
|----|-------------|
| TR-PERF-001 | `place_detail_cache` and `recommendation_cache` are `UNLOGGED`. |
| TR-PERF-002 | On cache miss or empty table, serve from logged tables; optionally fill cache. |
| TR-PERF-003 | After crash, a `pg_cron` or startup job truncates/rebuilds unlogged caches. |
| TR-PERF-004 | Trending: `MATERIALIZED VIEW` + `REFRESH CONCURRENTLY` via pg_cron (Phase 5–6). |
| TR-PERF-005 | `statement_timeout` default 5s for API transactions; search may set 1s. |

## 13. Jobs (pg_cron)

| Job | Phase | Cadence (default) |
|-----|-------|-------------------|
| Refresh `mv_trending_places` | 5–6 | 15 min |
| Rebuild stale embeddings (rows with `embedding_stale`) | 6 | nightly |
| Partition maintenance | 6 | daily |
| Purge expired refresh tokens / idempotency keys | 6 | daily |
| Generate digest rows | 6 | daily per tenant timezone in settings |
| Vacuum / analyze hints | 8 | document autovacuum; don’t cron vacuum blindly |

Cron functions must be tenant-safe (loop tenants or include `tenant_id` in SQL). They run as `tusk_cron` with documented DEFINER.

## 14. Observability

Phase 0–4: structured JSON logs (`requestId`, `tenantId`, route, status, latency_ms).

Phase 7+:

- `pg_stat_statements` enabled
- SQL views in `docs/ops/` for slow queries, unused indexes (optional), autovacuum
- k6 scripts for search + booking

## 15. Testing requirements

| ID | Test |
|----|------|
| TR-TEST-001 | Health without auth |
| TR-TEST-002 | Register/login/refresh |
| TR-TEST-003 | Cross-tenant: create place as A, GET as B with A’s id → 404 |
| TR-TEST-004 | Near-me returns points inside radius only |
| TR-TEST-005 | Two parallel bookings on capacity=1 → one 2xx, one 409 |
| TR-TEST-006 | FTS finds stemmed token; vector search returns nearer embedding first (mock embeddings) |
| TR-TEST-007 | JSONB `@>` filter |
| TR-TEST-008 | Cache truncate still serves place detail |

## 16. Performance design points (Phase 7 dataset)

Synthetic seed (not required before Phase 7):

- 50 tenants, 10k places/tenant (or 2 tenants × 10k for laptop), 50k experiences, 1M activity events

Search p95 target ≤ 150 ms on that laptop/CI class hardware is **aspirational**; the deliverable is EXPLAIN evidence and index justification, not a vanity number.

## 17. Migration & schema evolution

- Expand/contract: add nullable columns → backfill → constrain.
- Never drop a column in the same release that still reads it.
- RLS policy changes ship with tests in the same PR.
- Generated `fts` expressions: update via migration, rebuild index.

## 18. Failure modes

| Failure | Behavior |
|---------|----------|
| Postgres down | `/v1/ready` 503; `/v1/health` 200 if process up |
| Embedding provider down | Writes succeed; `embedding_stale=true`; search uses FTS+geo only |
| UNLOGGED lost | Miss path; log `cache_miss` |
| pg_cron missing in managed PG | Feature flag; document; skip jobs in that env |

## 19. Explicit non-requirements

- GraphQL gateway
- CDC to Kafka
- Redis rate limiter (use Postgres or in-memory per process only if needed; prefer not)
- Server-side rendering
- Kubernetes manifests (Phase 8 optional)

## 20. Traceability

Roadmap checkboxes cite `TR-*` / `FR-*`. New features need an FR in a feature PRD **and** TR updates if they change isolation, durability, or API contracts.
