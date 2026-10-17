# Tusk — Phase-wise Roadmap

**Rule:** implement the lowest incomplete phase until its **exit criteria** pass. Do not start the next phase’s features early except shared bugfixes.

**How to use:** check boxes only when the item exists in the repo *and* is verified (test or manual note). IDs refer to [PRD](PRD.md) / [TRD](TRD.md) / feature PRDs.

**Legend:** `[P]` product · `[T]` technical · `[D]` docs

---

## Phase 0 — Repository & runtime spine

**Objective:** A developer can boot Postgres (with extensions) and a Fastify process that answers health checks. No domain tables yet.

**Depends on:** nothing  
**Primary docs:** TR-C-*, TR stack §4

### Checklist

**Repo**
- [x] `[T]` pnpm workspace with `apps/api`
- [x] `[T]` TypeScript `strict`, `noUncheckedIndexedAccess`
- [x] `[T]` `.env.example` with all TRD variables
- [x] `[T]` `.gitignore` (node, env, IDE)
- [x] `[T]` Validation library chosen (TypeBox **or** Zod) and used on health if applicable
- [x] `[T]` Lint + format scripts (`pnpm lint`, `pnpm typecheck`)

**Compose**
- [x] `[T]` `deploy/docker-compose.yml`: Postgres 16+ with PostGIS
- [x] `[T]` Init: `CREATE EXTENSION` for `postgis`, `vector`, `pg_trgm`, `pg_stat_statements`, `pgcrypto` (or equivalent); `pg_cron` if image allows (document if not)
- [x] `[T]` Init: roles `tusk_migrator`, `tusk_app` (passwords via env)
- [x] `[T]` Named volume for PG data
- [x] `[T]` API service optional in Compose **or** run API on host against published 5432 — pick one, document in README

**API skeleton**
- [x] `[T]` Fastify 5 app entry, graceful shutdown
- [x] `[T]` `GET /v1/health` → 200 `{ data: { status: "ok" } }`
- [x] `[T]` `GET /v1/ready` → 200 if `SELECT 1` works, else 503
- [x] `[T]` JSON error handler matching TRD envelope
- [x] `[T]` `requestId` on every response (`X-Request-Id` + `meta.requestId`)
- [x] `[T]` postgres.js pool from `DATABASE_URL`

**Migrations**
- [x] `[T]` node-pg-migrate wired (`pnpm --filter api migrate`)
- [x] `[T]` Baseline migration: extensions + roles grants as needed (if not all in init)
- [x] `[T]` README local-run commands updated from placeholders

**Tests**
- [x] `[T]` Vitest runs
- [x] `[T]` Health test (no DB required)
- [x] `[T]` Ready test against Testcontainers or Compose Postgres

### Exit criteria

- [x] `docker compose up` yields a healthy Postgres with `postgis` and `vector` (`\dx`).
- [x] `curl /v1/health` and `/v1/ready` behave as specified.
- [x] CI job (or documented local equivalent) runs typecheck + tests.

### Out of scope

Auth, tables, RLS, search.

---

## Phase 1 — Identity, tenancy, RLS

**Objective:** Global users, tenants, memberships, JWT, **forced RLS**. Tenant A cannot read tenant B.

**Depends on:** Phase 0  
**Primary docs:** [prd/01-identity-tenancy.md](prd/01-identity-tenancy.md), TR §5–6, TR-SEC-*

### Checklist

**Schema**
- [x] `[T]` `tenants`, `users`, `memberships`, `refresh_tokens`
- [x] `[T]` UUIDv7 (or documented generator) for PKs
- [x] `[T]` `updated_at` trigger function reused later
- [x] `[T]` Indexes: `users(email)`, `memberships(tenant_id, user_id)` unique
- [x] `[T]` `FORCE ROW LEVEL SECURITY` + policies on tenant-scoped tables
- [x] `[T]` `tenants` visibility: members can select own tenant; platform admin via membership role `platform_admin` **or** separate flag on user — implement as specified in identity PRD
- [x] `[T]` App role has no `BYPASSRLS`

**API**
- [x] `[P]` `POST /v1/auth/register` (creates user + first tenant **or** join via invite — follow FR-ID-004 default: register creates user, tenant created via platform or bootstrap)
- [x] `[P]` Bootstrap path: first register may create a tenant (dev) — gated by `ALLOW_SELF_TENANT=true` for local
- [x] `[P]` `POST /v1/auth/login`, `refresh`, `logout`
- [x] `[P]` `GET /v1/me`
- [x] `[P]` `POST /v1/platform/tenants` (platform admin)
- [x] `[P]` `GET/PATCH /v1/admin/tenant` (tenant admin)

**App**
- [x] `[T]` Argon2id password hash
- [x] `[T]` Access JWT includes `sub`, `tid` (tenant), `role`
- [x] `[T]` Transaction wrapper: `set_config` for `app.tenant_id`, `app.user_id`, `app.role`
- [x] `[T]` Refresh rotation + hashed storage
- [x] `[T]` Mutating routes re-check membership in-tx (TR §6)

**Tests**
- [x] `[T]` TR-TEST-002 auth flow
- [x] `[T]` Two tenants, user B cannot read tenant A rows (use a dummy tenant-scoped table `rls_probe` if no places yet **or** seed tenants only and test `memberships` isolation)
- [x] `[T]` Missing `SET LOCAL` (query as app role without settings) returns zero rows

**Docs**
- [x] `[D]` README: how to create first platform admin

### Exit criteria

- Cross-tenant isolation test green.
- Register → login → me works.
- Policies live on all tenant tables introduced in this phase.

### Out of scope

Places, bookings, search.

---

## Phase 2 — Places & geospatial

**Objective:** CRUD places; near-me and bbox queries with PostGIS; GiST.

**Depends on:** Phase 1  
**Primary docs:** [prd/02-places-geospatial.md](prd/02-places-geospatial.md)

### Checklist

**Schema**
- [x] `[T]` `places`: `geog geography(Point,4326)`, `status`, `title`, `description`, `attrs jsonb`
- [x] `[T]` GiST on `geog`
- [x] `[T]` GIN on `attrs` (used more in Phase 5; cheap to add now)
- [x] `[T]` RLS: published readable by tenant members; write = host/admin/owner as FR-GEO-*
- [x] `[T]` Optional `tenant_boundaries geography(MultiPolygon,4326)` on tenants or `zones` table — **minimum:** one polygon per tenant optional; skip UI; if present, inserts must `ST_Covers` (FR-GEO-008)

**API**
- [x] `[P]` `POST /v1/places` (lon/lat in body)
- [x] `[P]` `GET /v1/places/:id`
- [x] `[P]` `GET /v1/places?lat=&lng=&radiusM=&limit=`
- [x] `[P]` `GET /v1/places?bbox=`
- [x] `[P]` Distance in response (`distanceM`)
- [x] `[P]` Order by distance when geo params present

**Tests**
- [x] `[T]` TR-TEST-003 with real places
- [x] `[T]` TR-TEST-004 radius
- [x] `[T]` Point outside bbox excluded

**Docs**
- [x] `[D]` Example `EXPLAIN` for near-me pasted into `docs/perf/phase2-places.md` (create folder)

> **Note (GiST + RLS):** Postgres 16.4+ only uses an index under RLS when the
> operator's underlying function is `LEAKPROOF`; PostGIS operators are not, so
> near-me queries go through `place_ids_within_radius` / `place_ids_within_bbox`
> (SECURITY DEFINER, owned by the BYPASSRLS migrator role, tenant read from the
> `app.tenant_id` GUC — never an argument). The API re-fetches ids through
> normal RLS queries. See [perf/phase2-places.md](perf/phase2-places.md).

### Exit criteria

- Near-me integration test green.
- GiST used in `EXPLAIN` (not seq scan on seeded ≥100 rows — seed in test).

### Out of scope

FTS, vectors, bookings.

---

## Phase 3 — Experiences & bookings

**Objective:** Hosts publish experiences and slots; explorers book without oversell.

**Depends on:** Phase 2  
**Primary docs:** [prd/03-experiences-bookings.md](prd/03-experiences-bookings.md), TR §9

### Checklist

**Schema**
- [x] `[T]` `experiences`, `experience_slots`, `bookings`, `idempotency_keys`
- [x] `[T]` FKs with tenant consistency (same `tenant_id` on child rows; composite FKs)
- [x] `[T]` Slot lock + capacity count (TR §9) — advisory lock, see [perf/phase3-bookings.md](perf/phase3-bookings.md)
- [x] `[T]` Booking statuses: `pending | confirmed | cancelled`
- [x] `[T]` Unique `(slot_id, user_id)` where status active (partial unique index)
- [x] `[T]` `categories` + `parent_id` (hierarchy used in Phase 4 filters; can be thin)

**API**
- [x] `[P]` Experience CRUD (create/list/get; patch as FR — no FR requires patch, none added)
- [x] `[P]` Slot create/list
- [x] `[P]` `POST .../bookings` with `Idempotency-Key`
- [x] `[P]` List my bookings; get by id; cancel
- [x] `[P]` `409 BOOKING_CAPACITY` / `BOOKING_CONFLICT`

**Tests**
- [x] `[T]` TR-TEST-005 concurrent capacity=1
- [x] `[T]` Idempotent replay returns same booking id
- [x] `[T]` Cancel frees capacity
- [x] `[T]` Host cannot book-over by skipping API (direct SQL as app role still RLS-bound)

**Docs**
- [x] `[D]` Comment + `docs/perf/phase3-bookings.md`: lock strategy chosen

### Exit criteria

- Concurrent booking test green (0 oversell).
- Idempotency works.

### Out of scope

Payments capture, search ranking.

---

## Phase 4 — Hybrid search & embeddings

**Objective:** One search endpoint blending FTS + vector + geo + popularity; embeddings on write.

**Depends on:** Phase 3 (experiences must exist); places from 2  
**Primary docs:** [prd/04-hybrid-search.md](prd/04-hybrid-search.md), [prd/05-recommendations.md](prd/05-recommendations.md) (naive recs), TR §8

### Checklist

**Schema**
- [ ] `[T]` Generated `fts` on `places` and `experiences` (+ GIN)
- [ ] `[T]` `embedding vector(N)` + `embedding_stale boolean` on places, experiences
- [ ] `[T]` HNSW cosine indexes
- [ ] `[T]` `popularity` column or view (bookings count / reviews — simple counter ok)
- [ ] `[T]` Ranking weights in `tenants.settings`

**App**
- [ ] `[T]` Embedding provider interface: `openai` | `voyage` | `mock`
- [ ] `[T]` On publish/update of searchable text: write row, then embed (same request **or** immediate async-in-process; do not drop the request if mock)
- [ ] `[T]` If provider fails: set `embedding_stale`, still commit text (TR §18)

**API**
- [ ] `[P]` `GET /v1/search` (`q`, geo, `limit`, cursor)
- [ ] `[P]` Response includes `score`, `distanceM` (if geo), `kind: place|experience`
- [ ] `[P]` `GET /v1/recommendations` naive: nearest neighbors to user pref embedding **or** popular-in-radius if no pref (FR-REC-001)

**Tests**
- [ ] `[T]` TR-TEST-006 mock embeddings
- [ ] `[T]` Text-only vs hybrid: fixture where keyword and semantic disagree; hybrid order documented
- [ ] `[T]` Search without `q` and without geo → 400

**Docs**
- [ ] `[D]` `docs/perf/phase4-search.md` EXPLAIN for hybrid SQL
- [ ] `[D]` Ranking formula restated with actual SQL aliases

### Exit criteria

- Hybrid search test green against real Postgres.
- HNSW index present (`\d` / `pg_indexes`).

### Out of scope

LISTEN/NOTIFY, pg_cron backfill (nightly job is Phase 6; on-write embed is this phase).

---

## Phase 5 — Documents, cache, materialized trending

**Objective:** JSONB content (reviews, itineraries, preferences); UNLOGGED caches; MV trending.

**Depends on:** Phase 4  
**Primary docs:** [prd/06-content-documents.md](prd/06-content-documents.md), TR §12

### Checklist

**Schema**
- [ ] `[T]` `reviews` with `payload jsonb` + GIN + fts
- [ ] `[T]` `itineraries.doc jsonb` + GIN
- [ ] `[T]` `user_preferences.doc jsonb`
- [ ] `[T]` UNLOGGED `place_detail_cache`
- [ ] `[T]` UNLOGGED `recommendation_cache`
- [ ] `[T]` `mv_trending_places` + unique index for concurrent refresh
- [ ] `[T]` Rebuild functions for unlogged tables (SQL)

**API**
- [ ] `[P]` Reviews list/create; JSONB containment filter `attrs` / payload
- [ ] `[P]` Itineraries CRUD (owner only)
- [ ] `[P]` `GET/PATCH /v1/me/preferences`
- [ ] `[P]` Place detail reads cache then origin (TR-PERF-002)
- [ ] `[P]` `GET /v1/places?trending=true` reads MV (or dedicated route)

**Tests**
- [ ] `[T]` TR-TEST-007 JSONB `@>`
- [ ] `[T]` TR-TEST-008 truncate unlogged → detail still 200
- [ ] `[T]` Review RLS: cannot review as other tenant

**Docs**
- [ ] `[D]` `docs/perf/phase5-cache.md`: unlogged vs logged note

**Jobs**
- [ ] `[T]` If `pg_cron` available: schedule MV refresh; else `pnpm` script documented as fallback **plus** SQL function ready for cron

### Exit criteria

- Cache miss test green.
- JSONB filter test green.
- MV exists and can refresh.

---

## Phase 6 — Background work, partitions, digests

**Objective:** pg_cron (or documented fallback) for maintenance; partitioned events; digest rows.

**Depends on:** Phase 5  
**Primary docs:** [prd/07-notifications-realtime.md](prd/07-notifications-realtime.md) (digest parts), TR §13

### Checklist

**Schema**
- [ ] `[T]` `activity_events` partitioned by `created_at` (monthly)
- [ ] `[T]` `audit_logs` partitioned **or** BRIN + documented later split
- [ ] `[T]` `digests` table (tenant, user, `body jsonb`, `period`)
- [ ] `[T]` pg_partman **optional**; if skipped, native partitions + create-next-month SQL job

**Jobs**
- [ ] `[T]` Nightly: `embedding_stale = true` backfill (batch)
- [ ] `[T]` Daily: purge expired refresh/idempotency rows
- [ ] `[T]` Daily: generate digest JSON from activity + recs snapshot
- [ ] `[T]` Partition create/drop (retain N months — default 12)

**API**
- [ ] `[P]` `GET /v1/digests/latest`
- [ ] `[P]` Activity writes on booking confirm + review create (insert `activity_events`)

**Tests**
- [ ] `[T]` Digest job function produces a row for a user with activity
- [ ] `[T]` Partition insert routes to correct partition (date fixture)

**Docs**
- [ ] `[D]` `docs/ops/jobs.md`: cadence, time zones, failure logging

### Exit criteria

- Digest fetch works for a seeded user.
- Events table is partitioned (verify `\d+ activity_events`).

### Out of scope

Push email, WebSockets.

---

## Phase 7 — Senior polish (realtime, recs v2, perf, ADRs)

**Objective:** LISTEN/NOTIFY feed; fuller SQL recs; observability views; k6; ADRs.

**Depends on:** Phase 6  
**Primary docs:** FR-RT-*, FR-REC-*, TR §14–16

### Checklist

**Realtime**
- [ ] `[T]` Trigger `NOTIFY tusk_activity, payload` on `activity_events` insert (payload small: ids only)
- [ ] `[P]` `GET /v1/feed` cursor list (DB pull is source of truth; NOTIFY is hint)
- [ ] `[T]` Optional: one Fastify plugin that LISTENs for local demo — document connection stickiness (not compatible with transaction pooling)

**Recs v2**
- [ ] `[P]` Recommendation SQL: vector similarity + collaborative-ish signal (e.g. co-booked experiences) in **one query**
- [ ] `[T]` Fill `recommendation_cache`; miss path live query with timeout

**Observability**
- [ ] `[T]` `pg_stat_statements` view wrappers in `docs/ops/sql/`
- [ ] `[T]` k6: search + booking scenarios
- [ ] `[D]` Record p50/p95 locally in `docs/perf/phase7-k6.md`

**ADRs** (required)
- [ ] `[D]` `docs/adr/001-postgres-only.md`
- [ ] `[D]` `docs/adr/002-unlogged-cache.md`
- [ ] `[D]` `docs/adr/003-hnsw-vs-ivfflat.md`
- [ ] `[D]` `docs/adr/004-rls-vs-app-tenancy.md`
- [ ] `[D]` `docs/adr/005-booking-locks.md`

**Pooling**
- [ ] `[T]` PgBouncer in Compose, transaction mode, app DSN through it
- [ ] `[T]` Verify SET LOCAL still works (must); set postgres.js `prepare: false` in `db/client.ts` (transaction pooling cannot reuse prepared statements)

**Tests**
- [ ] `[T]` Feed lists activity in order
- [ ] `[T]` Recs v2 returns deterministic order on mock vectors

### Exit criteria

- Four+ ADRs merged.
- k6 script runnable from README.
- PgBouncer path documented and used in Compose override or main file.

### Out of scope

K8s, logical replication (Phase 8).

---

## Phase 8 — Production readiness

**Objective:** Least privilege review, backup story, autovacuum notes, CI, optional replica concepts.

**Depends on:** Phase 7

### Checklist

**Security & ops**
- [ ] `[T]` Privilege audit: app role grants listed in `docs/ops/privileges.md`
- [ ] `[D]` Backup/restore: `pg_basebackup` or `pg_dump` runbook; PITR **concepts** (WAL archive) written even if local demo uses dump only
- [ ] `[D]` Autovacuum notes for unlogged vs logged, bloated `activity_events`
- [ ] `[D]` README “Postgres deep dive” section (trade-offs, not tutorial fluff)

**CI**
- [ ] `[T]` GitHub Actions (or equivalent): compose/testcontainer, migrate, test
- [ ] `[T]` No secrets in logs

**Optional**
- [ ] `[T]` Logical replication subscriber **or** written ADR why not in this repo
- [ ] `[T]` Read-only search role on replica (if replica exists)

**Product freeze**
- [ ] `[D]` Roadmap Phase 0–7 all checkboxes done or explicitly waived with reason

### Exit criteria

- CI green on a clean clone.
- Backup runbook tested once locally (dump/restore smoke).
- Privilege doc matches live grants.

---

## Waivers

If an environment cannot load `pg_cron` (e.g. some managed Postgres):

1. Implement the SQL **functions** anyway.
2. Document `pnpm jobs:*` wrappers in `docs/ops/jobs.md`.
3. Do not fake cron inside Node as the design — Node wrappers are a **dev stand-in**.

Record waivers here:

| Date | Phase | Item | Reason |
|------|-------|------|--------|
|      |       |      |        |

---

## Suggested sequence inside a session

1. Open this file; find first `[ ]`.
2. Read the feature PRD + TRD sections cited.
3. Implement the smallest vertical slice that can be tested.
4. Check the box.
5. Stop at phase exit unless the user asks to continue.
