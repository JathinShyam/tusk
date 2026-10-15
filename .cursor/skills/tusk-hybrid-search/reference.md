# Hybrid search SQL shape

Normalize **within the filtered candidate set** using window min/max. Tie-break `id`.

```sql
WITH params AS (
  SELECT
    $1::geography AS origin,          -- nullable
    $2::int AS radius_m,
    websearch_to_tsquery('english', $3) AS tsq,  -- empty q → skip FTS
    $4::vector AS qemb,               -- nullable
    $5::float AS w_text,
    $6::float AS w_sem,
    $7::float AS w_geo,
    $8::float AS w_pop
),
candidates AS (
  SELECT
    p.id,
    'place'::text AS kind,
    p.title,
    p.geog,
    CASE WHEN p.fts @@ (SELECT tsq FROM params) AND $3 <> ''
         THEN ts_rank_cd(p.fts, (SELECT tsq FROM params))
         ELSE 0 END AS raw_text,
    CASE WHEN p.embedding IS NOT NULL AND (SELECT qemb FROM params) IS NOT NULL
         THEN 1 - (p.embedding <=> (SELECT qemb FROM params))
         ELSE 0 END AS raw_sem,
    CASE WHEN (SELECT origin FROM params) IS NOT NULL
         THEN ST_Distance(p.geog, (SELECT origin FROM params))
         ELSE 0 END AS distance_m,
    COALESCE(p.popularity, 0)::float AS raw_pop
  FROM places p, params
  WHERE p.status = 'published'
    AND (
      params.origin IS NULL
      OR ST_DWithin(p.geog, params.origin, params.radius_m)
    )
    AND (
      $3 = ''
      OR p.fts @@ params.tsq
      OR params.qemb IS NOT NULL  -- semantic-only candidates: cap with extra LIMIT subquery if needed
    )
  -- UNION ALL analogous SELECT from experiences
),
scored AS (
  SELECT
    c.*,
    CASE WHEN max(raw_text) OVER () = min(raw_text) OVER () THEN 0
         ELSE (raw_text - min(raw_text) OVER ())
              / nullif(max(raw_text) OVER () - min(raw_text) OVER (), 0)
    END AS n_text,
    -- repeat for n_sem, n_pop
    exp(-distance_m / 5000.0) AS n_geo
  FROM candidates c
)
SELECT
  id, kind, title, distance_m,
  (SELECT w_text FROM params) * n_text
  + (SELECT w_sem FROM params) * n_sem
  + CASE WHEN (SELECT origin FROM params) IS NULL THEN (SELECT w_geo FROM params)
         ELSE (SELECT w_geo FROM params) * n_geo END
  + (SELECT w_pop FROM params) * n_pop AS score
FROM scored
ORDER BY score DESC, id
LIMIT $limit;
```

Tune the FTS-or-semantic `WHERE` so it does not sequential-scan the tenant. Typical pattern: if `q` present, require `fts @@ tsq` **or** use a `LATERAL` ANN subquery (`ORDER BY embedding <=> qemb LIMIT k`) UNION FTS hits, then score the union. Prefer **UNION of two limited sets** over `OR` that kills index use.

## ANN subquery (HNSW)

```sql
SELECT id FROM places
WHERE status = 'published'
ORDER BY embedding <=> $qemb
LIMIT 100;
```

Requires non-null embeddings; filter `embedding IS NOT NULL`.

## EXPLAIN

Always `EXPLAIN (ANALYZE, BUFFERS)` on a seeded tenant. Capture in `docs/perf/phase4-search.md`. If seq scan on places, fix `WHERE` before adding more weights.
