# Tusk

Production-grade, **Postgres-only** backend for a Local Experiences & Intelligence Hub: geospatial discovery, hybrid full-text + semantic search, AI recommendations, multi-tenant isolation, and real-time activity — all in one PostgreSQL instance.

This repository is the system a senior SDE would own end-to-end: schema, API, performance, security, and operations. There is no Redis, Elasticsearch, Pinecone, MongoDB, or external scheduler.

**Status:** Phase 1 complete on branch `phase-1` (identity, tenancy, JWT, forced RLS). Next: Phase 2 (places + geospatial). See [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Product in one paragraph

A city, brand, or enterprise **tenant** runs an isolated local-discovery product. End users find nearby places and bookable experiences, search with keywords and meaning, get personalized recommendations, publish reviews and itineraries, and receive activity plus scheduled digests. Operators get tenant-scoped data, RLS isolation, and operational visibility into Postgres itself.

Read [`docs/PRD.md`](docs/PRD.md) for product scope and [`docs/TRD.md`](docs/TRD.md) for the technical contract.

---

## Non-negotiable constraints

| Must | Must not |
|------|----------|
| Single primary Postgres (replica later, still Postgres) | Redis, Memcached, Elasticsearch, OpenSearch, Pinecone, Weaviate, Mongo, Kafka-as-source-of-truth |
| PostGIS, pgvector, `tsvector`, JSONB, UNLOGGED, MVs, RLS, `pg_cron` | Prisma or any schema-hiding ORM |
| Fastify + TypeScript + REST `/v1` | GraphQL, tRPC, NestJS |
| Explicit SQL (`postgres.js`) | Business logic that bypasses RLS with ad-hoc `WHERE tenant_id` as the only control |
| Embeddings computed in Node, stored as `vector` | PL/Python in-database model calls for v1 |
| Jobs via `pg_cron` (+ app workers that *are triggered by* DB state) | Sidekiq/Bull/Redis queues as the system of record |

---

## Stack (locked)

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5.x (strict) |
| HTTP | Fastify 5, REST, JSON |
| Validation | TypeBox (Fastify schema) or Zod at boundaries — pick one in Phase 0 and keep it |
| SQL client | [`postgres`](https://github.com/porsager/postgres) (postgres.js) |
| Migrations | SQL files via [node-pg-migrate](https://github.com/salsita/node-pg-migrate) |
| Auth | JWT access + refresh rows in Postgres |
| Database | PostgreSQL 16+ with PostGIS, pgvector, pg_trgm, pg_cron, pg_stat_statements (pg_partman from Phase 6) |
| Local run | Docker Compose (API + Postgres + later PgBouncer) |
| Tests | Vitest + Testcontainers (real Postgres with extensions) |
| Load | k6 (Phase 7) |

Frontend is **out of scope** until the search + booking path is real (see roadmap). Maps UI is not a Phase 0–4 deliverable.

---

## Architecture (target)

```
Client
  └─ HTTPS JSON  /v1/*
       └─ Fastify
            ├─ auth (JWT) → request context
            ├─ transaction + SET LOCAL (tenant, user, role)
            ├─ modules (identity, places, experiences, search, recs, content, feed)
            └─ postgres.js pool
                 └─ PostgreSQL
                      ├─ relational core + constraints
                      ├─ RLS (forced)
                      ├─ PostGIS / tsvector / pgvector / JSONB
                      ├─ UNLOGGED caches + materialized views
                      ├─ pg_cron + LISTEN/NOTIFY
                      └─ partitions (events, audit)
```

No other datastore. Caches that disappear on crash must rebuild from logged tables.

---

## Docs map

| Document | Role |
|----------|------|
| [docs/PRD.md](docs/PRD.md) | Master product requirements, personas, non-goals |
| [docs/prd/](docs/prd/) | Feature PRDs (identity, geo, bookings, search, recs, content, realtime) |
| [docs/TRD.md](docs/TRD.md) | Technical requirements, schema, API, security, SLOs |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase-wise work, checklists, exit criteria |
| [AGENTS.md](AGENTS.md) | How coding agents must work in this repo |

Traceability: feature PRDs use `FR-*` IDs; TRD uses `TR-*` IDs; roadmap checkboxes reference both.

---

## Postgres capabilities this system must exercise

| Capability | Feature | Tusk use |
|------------|---------|-----------|
| Isolation | RLS + `FORCE ROW LEVEL SECURITY` | Tenant and role isolation |
| Geo | PostGIS `geography` + GiST | Near-me, radius, bbox, distance rank |
| Keywords | `tsvector` / `tsquery` + GIN | Titles, descriptions, reviews |
| Semantic | pgvector + HNSW | Places, experiences, reviews, profiles |
| Documents | JSONB + GIN | Attributes, preferences, itineraries |
| Cache | `UNLOGGED` tables | Hot place snapshots, rec caches |
| Precompute | Materialized views | Trending / popular |
| Jobs | `pg_cron` | MV refresh, cleanup, digests, partition maint |
| Time-series | Range partitioning | Events, audit, notification log |
| Concurrency | Constraints + advisory locks | Double-booking prevention |
| Realtime | `LISTEN/NOTIFY` | Activity feed fan-out (Phase 7) |

---

## Hybrid ranking (v1 contract)

Search blends four normalized signals (weights live in tenant JSONB, defaults below):

```
score = 0.35 * text_rank
      + 0.30 * (1 - cosine_distance)
      + 0.20 * exp(-distance_m / 5000)
      + 0.15 * popularity
```

Changing weights is a product/config change, not a rewrite of the query shape. Document every plan change with `EXPLAIN ANALYZE` in `docs/perf/` (created in Phase 5).

---

## Repository layout (target after Phase 0)

```
apps/api/                 # Fastify service
  src/
    http/                 # plugins, error handler, envelope
    db/                   # pool, tx + SET LOCAL, sql fragments
    modules/              # one folder per bounded context
    lib/
  test/
  migrations/
deploy/
  docker-compose.yml
  postgres/               # init scripts, extensions
docs/
.cursor/                  # skills, agents, rules
```

**Phase 0 spine is implemented** on branch `phase-0`: Compose Postgres (PostGIS + pgvector + …), Fastify `/v1/health` + `/v1/ready`, migrations, Vitest.

**Runtime choice:** Postgres runs in Docker; the API runs on the host against published `5432` (not an API container in Phase 0).

**Validation:** TypeBox (Fastify type provider). **Lint:** oxlint.

---

## Local run

```bash
cp .env.example .env
corepack enable && corepack prepare pnpm@9.15.9 --activate
pnpm install

# Postgres with extensions + tusk_app / tusk_migrator roles
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --wait

# Baseline migration (grants; extensions come from Compose init)
pnpm migrate

pnpm dev
# curl -s http://localhost:3000/v1/health
# curl -s http://localhost:3000/v1/ready
```

Verify extensions:

```bash
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U postgres -d tusk -c '\dx'
```

Tests (health unit + integration against the Compose Postgres; migrations run automatically):

```bash
pnpm typecheck && pnpm lint && pnpm test
```

CI: `.github/workflows/ci.yml` runs typecheck, lint, and tests on `main` / `phase-0` / `phase-1`.

---

## Identity & tenancy (Phase 1)

Endpoints: `POST /v1/auth/register|login|refresh|logout|switch-tenant`, `GET /v1/me`,
`POST /v1/platform/tenants`, `GET|PATCH /v1/admin/tenant`, `POST /v1/admin/memberships` (invite by email).

Isolation model: `tusk_app` connects with **no BYPASSRLS**; every request opens one transaction and sets
`app.tenant_id` / `app.user_id` / `app.role` via `set_config(..., true)`. Policies on `tenants` and
`memberships` cast through `nullif(current_setting(..., true), '')` (a reverted `SET LOCAL` reads back as `''`,
not `NULL`). With no settings, queries return zero rows — verified by `test/rls.test.ts`, including a
pooled-connection residue test.

Self-serve tenant creation on register is gated by `ALLOW_SELF_TENANT=true` (dev only); production registers
tenant-less users who join via platform tenant creation or an admin invite.

### Creating the first platform admin

The platform admin flag lives on the (global, non-RLS) `users` table and is never settable through the API.
Bootstrap the first one with SQL:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml exec postgres \
  psql -U postgres -d tusk -c \
  "UPDATE users SET is_platform_admin = true WHERE email = 'you@example.com';"
```

Register that email first (`POST /v1/auth/register` without a `tenant`), then log in: a platform admin gets a
tenant-less token until they `switch-tenant`. Platform admins can `POST /v1/platform/tenants` (creating a tenant
auto-adds the creator as its `tenant_admin`) and act inside any tenant.

---

## What “done” means for the portfolio

- Schema + migration history that a reviewer can read without the app
- README + this docs set explaining **trade-offs**, not just features
- Benchmarks: before/after indexes; unlogged vs logged; text-only vs hybrid
- ADRs for unlogged cache, HNSW vs IVFFlat, RLS vs app-level tenancy (Phase 7)
- Compose that boots extensions used in production
- CI: migrate + integration tests against real Postgres

---

## Working with Cursor

Project skills, subagents, and rules live under `.cursor/`. Agents must follow [AGENTS.md](AGENTS.md): implement the **current roadmap phase only**, keep SQL explicit, and never introduce a second database.
