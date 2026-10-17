# Phase 2 — near-me `EXPLAIN` (places, PostGIS GiST under RLS)

Setup: Postgres 16.15 + PostGIS 3.6.4. One tenant seeded with 3000 published
`places` scattered over ~0.2° around London (-0.1276, 51.5072). Near-me query:

```sql
SELECT id, round(ST_Distance(geog, origin))::int AS distance_m
FROM places
WHERE status = 'published'
  AND ST_DWithin(geog, origin, 1000)
ORDER BY distance_m, id
LIMIT 20;
```

## Finding: RLS makes `places_geog_gix` unreachable for `tusk_app`

Since PostgreSQL 16.4 (CVE-2024-10976), a qual can only become an index
condition on an RLS-protected table if its underlying function is marked
`LEAKPROOF`. The PostGIS geography operators (`&&`, `ST_DWithin`,
`ST_Intersects`) are not leakproof, so with `FORCE RLS` the planner cannot use
the GiST index for the app role.

### As `tusk_app` (RLS): tenant btree only — the whole tenant is scanned

```
 Limit  (actual time=45.110..45.116 rows=20 loops=1)
   ->  Sort  (Sort Key: ((round(st_distance(geog, '...'::geography, true)))::integer), id)
         ->  Index Scan using places_tenant_created_idx on places
               Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
               Filter: ((status = 'published'::text) AND (policy quals) AND st_dwithin(geog, '...'::geography, '1000'::double precision, true))
               Rows Removed by Filter: 2972
```

`Rows Removed by Filter: 2972` of 3000 → cost grows linearly with tenant size.
Warm wall clock (3 runs, `\timing`): **~7.6–11.8 ms** at 3k rows.

### As the functions' owner (`tusk_migrator`, BYPASSRLS): GiST works

```
 Limit  (actual time=10.156..10.160 rows=21 loops=1)
   ->  Sort  (Sort Key: ((round(st_distance(p.geog, '...'::geography, true)))::integer), p.id)
         ->  Bitmap Heap Scan on places p
               Filter: ((status = 'published'::text) AND (tenant_id = ...) AND st_dwithin(...))
               Rows Removed by Filter: 38
               ->  Bitmap Index Scan on places_geog_gix
                     Index Cond: (geog && _st_expand('...'::geography, '1000'::double precision))
```

Candidate rows come from the spatial index; only ~66 are examined instead of
the whole tenant. Warm wall clock via `place_ids_within_radius(...)` as
`tusk_app`: **~0.8–1.5 ms**.

## Mitigation (Phase 2 choice)

Migration `1740400000000_places-spatial-functions.cjs` adds two SECURITY
DEFINER functions owned by the `BYPASSRLS` migrator role:

- `place_ids_within_radius(lng, lat, radius_m, after_distance_m, after_id, max_rows)`
- `place_ids_within_bbox(west, south, east, north, after_created_at, after_id, max_rows)`

Safety measures: the tenant is read from the same `app.tenant_id` GUC the RLS
policies use (never from an argument; clients cannot set GUCs), only
`status = 'published'` rows are candidates, `EXECUTE` is revoked from PUBLIC
and granted only to `tusk_app`, and the API re-fetches the returned ids through
normal RLS queries — the policies still gate every row in a response.

Alternatives considered:

- **Bounding-box columns + btree** (`lat`/`lng` ranges are leakproof): works
  under RLS, but GiST stays idle for API queries and Phase 4 FTS + GIN hits
  the same leakproof wall.
- **Marking PostGIS functions `LEAKPROOF`** as superuser: least code, but
  cluster-local, lost on extension upgrade, and impossible on managed
  Postgres.

References: PostgreSQL documentation, *Security Barrier Views and Row-Level
Security* (index conditions require `LEAKPROOF`); CVE-2024-10976.

## Reproduce

```sh
# seed a tenant + 3000 published places (see test/places.test.ts for the
# 120-row variant), then:
psql "postgres://tusk_app:tusk_app@localhost:5432/tusk" \
  -c "SET app.tenant_id = '<tenant>'; SET app.role = 'tenant_admin'; EXPLAIN (ANALYZE, BUFFERS) \
      SELECT * FROM place_ids_within_radius(-0.1276, 51.5072, 1000, NULL, NULL, 21)"
```

The integration test (`apps/api/test/places.test.ts`, "exit criteria" case)
runs `EXPLAIN (ANALYZE, BUFFERS)` on the function body as its owner (the same
role the function executes as), seeds 1200 published places first, and asserts
`places_geog_gix` appears in the plan without any planner hints.
