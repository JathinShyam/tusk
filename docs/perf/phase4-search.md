# Phase 4 — hybrid search `EXPLAIN` (FTS + pgvector + geo under RLS)

Setup: Postgres 16.15, pgvector, PostGIS. One tenant seeded with 1200
published `places` (embeddings back-filled with random unit vectors for the ANN
plan; the same tenant's rows drive the FTS plan).

## Finding: the same LEAKPROOF wall as Phase 2

Under `FORCE RLS`, an operator can become an index condition only if its
underlying function is `LEAKPROOF` (PostgreSQL ≥ 16.4, CVE-2024-10976). Both
search operators fail this check:

```
                                    proname     | proleakproof
-----------------------------------------------+--------------
 ts_match_vq      (@@  -> text search)         | f
 cosine_distance  (<=> -> pgvector)            | f
```

So `places_fts_gin` (GIN) and `places_embedding_hnsw` (HNSW) are unreachable
for `tusk_app` on an RLS-protected table, exactly like `places_geog_gix` in
Phase 2.

### Mitigation

`search_hybrid(...)` (migration `1740700000000`) is `SECURITY DEFINER`, owned by
the `BYPASSRLS` migrator role, and reads the tenant from the same
`app.tenant_id` GUC the policies use — never an argument. It shortlists
candidate ids from per-signal `UNION ALL` branches (text / ANN / geo /
trending), ranks them with window-function normalisation, and returns
`(kind, id, score, distance_m)`. The API re-fetches every id through normal
`places` / `experiences` RLS queries, so the policies remain the gate for what
reaches a response.

### FTS branch — GIN is used for selective terms

`Seed` matches ~98% of the rows, so the planner correctly prefers a scan over
GIN. A selective term (`xylophonezzq`, 1 row) uses the index:

```
 Limit
   ->  Sort  (Sort Key: ts_rank_cd(fts, '''xylophonezzq'''::tsquery) DESC)
         ->  Bitmap Heap Scan on places
               Recheck Cond: (fts @@ '''xylophonezzq'''::tsquery)
               ->  Bitmap Index Scan on places_fts_gin       <-- GIN
                     Index Cond: (fts @@ '''xylophonezzq'''::tsquery)
 Execution Time: 0.039 ms
```

### ANN branch — HNSW is valid and faster when chosen

With the tenant prefilter (1200 rows of 6.2k) the cost model prefers exact
top-N: bitmap scan on `places_tenant_id_unique` + `top-N heapsort`, **~5.4 ms**.
That is the correct choice at this size — HNSW is approximate.

Removing the sort alternative shows the index plan the definer function can
reach, and it is faster (**2.2 ms** vs **6.4 ms** for the scan+sort):

```
SET enable_seqscan = off; SET enable_sort = off;
 Limit
   ->  Index Scan using places_embedding_hnsw on places   <-- HNSW (cosine)
         Order By: (embedding <=> $0)
         Filter: (embedding IS NOT NULL)
 Execution Time: 2.381 ms
```

HNSW's sublinear cost overtakes the sort once a tenant's embedded set is large;
until then the exact plan is preferred and still correct.

### Whole function

`EXPLAIN` on the call itself is opaque (`Function Scan on search_hybrid`), so
the branch plans above are captured ad hoc against the same predicates the
function emits.

## Ranking formula with actual SQL aliases

```
-- signals CTE
raw_text  = ts_rank_cd(fts, websearch_to_tsquery('english', q))   -- 0 if q empty
raw_sem   = 1 - (embedding <=> q_embedding)                        -- 0 if q_embedding NULL or embedding_stale
distance_m= ST_Distance(geog, origin)                              -- NULL if no geo
raw_pop   = count(active bookings for the row / place)             -- computed live

-- scored CTE (min-max over the filtered candidate set)
n_text = (raw_text - min(raw_text) OVER ()) / nullif(max(raw_text) OVER () - min(raw_text) OVER (), 0)
n_sem  = (raw_sem  - min(raw_sem)  OVER ()) / nullif(max(raw_sem)  OVER () - min(raw_sem)  OVER (), 0)
n_pop  = (raw_pop  - min(raw_pop)  OVER ()) / nullif(max(raw_pop)  OVER () - min(raw_pop)  OVER (), 0)
n_geo  = CASE WHEN origin IS NULL THEN 1 ELSE exp(-distance_m / 5000.0) END

-- final CTE
score = w_text*n_text + w_sem*n_sem + w_geo*n_geo + w_pop*n_pop
```

Weights default to `0.35 / 0.30 / 0.20 / 0.15` (text, semantic, geo,
popularity) and are read per tenant from `tenants.settings->'ranking'`
(`text`, `semantic`, `geo`, `popularity`). Pagination is keyset on
`(score DESC, id)`.

## Notes

- **Popularity is a live aggregate**, not a stored column/view: `search_hybrid`
  counts `bookings` with `status IN ('pending','confirmed')` while running as
  the definer owner, so the `bookings` SELECT policy (which hides other users'
  rows) cannot skew it. A stored counter/MV arrives with reviews in Phase 5.
- Embedding failures (TR §18) leave `embedding_stale = true`; the semantic
  branch and `raw_sem` both ignore stale rows, so such rows stay reachable via
  FTS + geo (FR-SRCH-010).

## Reproduce

```sql
SET enable_seqscan = off; SET enable_sort = off;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM places
WHERE embedding IS NOT NULL
ORDER BY embedding <=> (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
                        FROM generate_series(1, 1536))
LIMIT 200;
```
