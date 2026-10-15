# Tusk — Product Requirements Document (Master)

**Version:** 1.0  
**Status:** Approved for Phase 0–4 implementation; Phases 5–8 specified, not committed to a date  
**Owner:** Engineering (single-operator / portfolio system)  
**Related:** [Feature PRDs](prd/) · [TRD](TRD.md) · [Roadmap](ROADMAP.md)

---

## 1. Vision

Tusk is a **multi-tenant Local Experiences & Intelligence Hub**: Airbnb Experiences-like booking, map-grade “near me”, and personalized recommendations — operated as SaaS for cities, brands, and enterprise clients.

Each tenant is a fully isolated product surface (data, users, content, rankings). The platform owner runs many tenants on one Postgres-backed API.

## 2. Problem

Local discovery products usually split the problem across four systems (primary DB, search engine, vector DB, cache). That fragments consistency, tenancy, and operations. Tusk proves a single Postgres instance can be the system of record **and** the query engine for geo, keyword, semantic, document, cache, and job workloads — without becoming a toy CRUD app.

## 3. Goals

| ID | Goal | Measure |
|----|------|---------|
| G1 | A guest finds a relevant nearby experience in one search request | Hybrid search returns ranked hits with distance + text + semantic signals |
| G2 | Two guests cannot overbook the same slot | Capacity invariant holds under concurrency tests |
| G3 | Tenant data never leaks | RLS tests: cross-tenant UUID access returns empty/404, not the row |
| G4 | Recommendations degrade gracefully | If cache UNLOGGED tables are empty, recs still compute from logged data |
| G5 | Operators can explain the system | Docs + EXPLAIN artifacts + ADRs for major trade-offs |

## 4. Non-goals (product)

| ID | Non-goal | Notes |
|----|----------|-------|
| NG1 | Consumer mobile apps / Next.js maps in Phases 0–6 | API-first; UI only after search+booking |
| NG2 | Being a full payments processor | Store `externalPaymentId` + status; no card data |
| NG3 | Multi-region active-active | Single primary; read replica is Phase 8 optional |
| NG4 | Social network (follows, DMs, stories) | Reviews + itineraries + activity feed only |
| NG5 | Marketplace logistics (refunds, disputes, tax) | Booking states only; no finance engine |
| NG6 | Arbitrary third-party plugin marketplace | Tenant feature flags via JSONB, not a plugin runtime |

## 5. Personas

| Persona | Tenant context | Jobs to be done |
|---------|----------------|-----------------|
| **Explorer** | Guest user | Discover nearby places/experiences, search, book, review, follow a digest |
| **Host** | Lists experiences | Publish experience, set capacity/schedule, see bookings |
| **Tenant admin** | City / brand / enterprise | Manage users, boundaries, feature flags, ranking weights |
| **Platform admin** | Tusk operator | Provision tenants, inspect health, run privileged maintenance (BYPASSRLS role only in ops) |

## 6. Tenant model

A **tenant** is the isolation unit. Types:

- `city` — municipal or DMO (destination marketing org)
- `brand` — hospitality / publisher white-label
- `enterprise` — company local perks / offsites

Rules:

- Every product row is tenant-scoped (except platform catalog tables explicitly marked global).
- Users belong to one or more tenants via memberships; a request always has **exactly one active tenant**.
- Custom domains / branding are JSONB on `tenants.settings` — not a separate CMS.

## 7. Core user journeys

### J1 — Near-me discovery

Explorer allows location → `GET /v1/places` with `lat`, `lng`, `radiusM` → ranked list → place detail.

### J2 — Hybrid search

Explorer types a query (e.g. “quiet wine tasting”) → `GET /v1/search` → results mixing keyword, semantic similarity, distance, popularity.

### J3 — Book an experience

Explorer selects experience + slot → `POST /v1/experiences/:id/bookings` → confirmed or conflict → cannot exceed capacity.

### J4 — Host publish

Host creates experience with structured fields + JSONB attributes → appears in search after indexes/embeddings catch up (sync on write for v1).

### J5 — Review and preference

Explorer posts review (semi-structured) → updates place aggregates and (async/nightly) embeddings used in recs.

### J6 — Personalized recs

Explorer opens recs → `GET /v1/recommendations` → uses profile embedding + behavior; if cache cold, compute live with timeout budget (TRD).

### J7 — Digest (Phase 6+)

`pg_cron` builds per-user digest rows; Explorer fetches `GET /v1/digests/latest` (pull model in v1; push email is optional stub).

## 8. Feature index

| PRD | Phase (primary) | IDs |
|-----|-----------------|-----|
| [Identity & tenancy](prd/01-identity-tenancy.md) | 1 | FR-ID-* |
| [Places & geospatial](prd/02-places-geospatial.md) | 2 | FR-GEO-* |
| [Experiences & bookings](prd/03-experiences-bookings.md) | 3 | FR-EXP-* |
| [Hybrid search](prd/04-hybrid-search.md) | 4 | FR-SRCH-* |
| [Recommendations](prd/05-recommendations.md) | 4–7 | FR-REC-* |
| [Content & documents](prd/06-content-documents.md) | 5 | FR-DOC-* |
| [Notifications & realtime](prd/07-notifications-realtime.md) | 6–7 | FR-RT-* |

Caching, cron, partitioning, observability are **technical** (TRD + roadmap), not separate product PRDs, except where they change user-visible behavior (stale trending, digest timing).

## 9. Information architecture (product objects)

| Object | User-facing meaning |
|--------|---------------------|
| Tenant | The branded world the user is in |
| Place | A durable location (venue, POI, neighborhood node) |
| Experience | A bookable offering, usually at a place |
| Slot / availability | When an experience can be booked and remaining capacity |
| Booking | A reserved capacity unit for a user |
| Review | Semi-structured opinion + ratings |
| Itinerary | Ordered document of places/experiences |
| Recommendation | Ranked suggestion, not a booking |
| Activity | Feed item (booking, review, new experience) |
| Digest | Scheduled summary of activity + recs |

## 10. Permissions (product)

| Action | Explorer | Host | Tenant admin | Platform admin |
|--------|----------|------|--------------|----------------|
| Read public places/experiences in tenant | ✓ | ✓ | ✓ | ✓ |
| Book | ✓ | ✓ | ✓ | ✓ |
| Create experience | — | ✓ (own) | ✓ | ✓ |
| Moderate reviews | — | limited | ✓ | ✓ |
| Change ranking weights / flags | — | — | ✓ | ✓ |
| Create tenant | — | — | — | ✓ |

Fine-grained RLS policies are specified in the TRD and identity PRD. Product rule: **hosts only mutate rows they own** unless tenant admin.

## 11. Success metrics (when traffic exists)

| Metric | Target (design) |
|--------|-----------------|
| Search p95 (hybrid, warm) | ≤ 150 ms at Phase 7 dataset size (see TRD) |
| Booking conflict rate under load | 0 oversell; conflicts return `409` |
| Cross-tenant leak | 0 in automated suite |
| Cache drop | Recs and place detail still serve; p95 may degrade (documented) |

Until load tests exist, metrics are **acceptance tests**, not production SLOs.

## 12. Launch slices

| Slice | Ships when | User can |
|-------|------------|----------|
| A | End of Phase 1 | Register/login; JWT; tenant-scoped empty world |
| B | End of Phase 2 | List/create places; near-me |
| C | End of Phase 3 | Create experience; book without oversell |
| D | End of Phase 4 | Hybrid search + embedding-on-write |
| E | End of Phase 5–6 | Reviews/itineraries; trending MV; digests |
| F | End of Phase 7–8 | Feed notify; perf artifacts; hardening |

## 13. Glossary

| Term | Meaning |
|------|---------|
| Active tenant | Tenant id on the JWT / session for this request |
| Logged table | Crash-safe WAL-logged relation |
| Unlogged cache | Relation that may be empty after crash; rebuildable |
| Hybrid search | Single query combining FTS, vector, geo, popularity |
| Membership | User ↔ tenant + role |
| Slot | Bookable time range + capacity for an experience |

## 14. Open product questions (resolved defaults)

| Question | Default until revisited |
|----------|-------------------------|
| Multi-city in one tenant? | Yes; geo is row-level, tenant is isolation |
| Guest checkout without account? | No; auth required to book |
| Host payouts? | Out of scope |
| Content language? | `lang` on searchable text; FTS config `english` v1; extra configs later |
| Map tiles? | Out of scope; API returns GeoJSON-ish coordinates only |
