/**
 * Phase 4: hybrid search candidate + ranking function (TRD §8, FR-SRCH-*).
 *
 * WHY SECURITY DEFINER: `@@` (GIN) and `<=>` (HNSW) are NOT LEAKPROOF (verified:
 * `proleakproof = f` for `ts_match_vq` and `cosine_distance`), so under `FORCE
 * RLS` the planner cannot use either index for `tusk_app`. The candidate
 * branches below therefore run as the BYPASSRLS migrator owner, reading the
 * tenant from the same `app.tenant_id` GUC the policies use (never an
 * argument), and the API re-fetches every returned id through normal RLS
 * queries — the policies stay the gate for what reaches a response. Same
 * pattern as the Phase 2 spatial functions (docs/perf/phase2-places.md).
 *
 * Popularity is a live count of active bookings, so it is accurate despite the
 * bookings SELECT policy hiding other users' rows from the caller.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
CREATE FUNCTION search_hybrid(
  p_q           text,
  p_embedding   vector,
  p_lng         double precision,
  p_lat         double precision,
  p_radius_m    double precision,
  p_kind        text,
  p_category_id uuid,
  p_exclude_ids uuid[],
  p_w_text      double precision,
  p_w_sem       double precision,
  p_w_geo       double precision,
  p_w_pop       double precision,
  p_after_score double precision,
  p_after_id    uuid,
  p_max_rows    integer
)
RETURNS TABLE (kind text, id uuid, score double precision, distance_m double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH params AS (
    SELECT
      nullif(p_q, '') AS q,
      CASE WHEN nullif(p_q, '') IS NOT NULL
           THEN websearch_to_tsquery('english', p_q) END AS tsq,
      CASE WHEN p_lng IS NOT NULL AND p_lat IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography END AS origin,
      coalesce(p_exclude_ids, '{}'::uuid[]) AS exclude_ids
  ),
  -- shortlist: UNION of per-signal limited sets avoids an OR that would kill
  -- index use. 200 is a fixed candidate cap (shortcut: raise/parameterise if a
  -- tenant ever has >200 relevant hits per signal).
  candidates AS (
    ( SELECT 'place'::text AS kind, p.id
      FROM places p, params
      WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND p.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'place')
        AND params.tsq IS NOT NULL
        AND p.fts @@ params.tsq
      ORDER BY ts_rank_cd(p.fts, params.tsq) DESC
      LIMIT 200 )
    UNION ALL
    ( SELECT 'experience'::text AS kind, e.id
      FROM experiences e, params
      WHERE e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND e.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'experience')
        AND (p_category_id IS NULL OR e.category_id = p_category_id)
        AND NOT (e.id = ANY(params.exclude_ids))
        AND params.tsq IS NOT NULL
        AND e.fts @@ params.tsq
      ORDER BY ts_rank_cd(e.fts, params.tsq) DESC
      LIMIT 200 )
    UNION ALL
    ( SELECT 'place'::text AS kind, p.id
      FROM places p, params
      WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND p.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'place')
        AND p_embedding IS NOT NULL
        AND p.embedding IS NOT NULL
        AND NOT p.embedding_stale
      ORDER BY p.embedding <=> p_embedding
      LIMIT 200 )
    UNION ALL
    ( SELECT 'experience'::text AS kind, e.id
      FROM experiences e, params
      WHERE e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND e.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'experience')
        AND (p_category_id IS NULL OR e.category_id = p_category_id)
        AND NOT (e.id = ANY(params.exclude_ids))
        AND p_embedding IS NOT NULL
        AND e.embedding IS NOT NULL
        AND NOT e.embedding_stale
      ORDER BY e.embedding <=> p_embedding
      LIMIT 200 )
    UNION ALL
    ( SELECT 'place'::text AS kind, p.id
      FROM places p, params
      WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND p.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'place')
        AND params.origin IS NOT NULL
        AND ST_DWithin(p.geog, params.origin, p_radius_m)
      LIMIT 200 )
    UNION ALL
    ( SELECT 'experience'::text AS kind, e.id
      FROM experiences e
      JOIN places pl ON pl.id = e.place_id
      CROSS JOIN params
      WHERE e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND e.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'experience')
        AND (p_category_id IS NULL OR e.category_id = p_category_id)
        AND NOT (e.id = ANY(params.exclude_ids))
        AND params.origin IS NOT NULL
        AND ST_DWithin(pl.geog, params.origin, p_radius_m)
      LIMIT 200 )
    UNION ALL
    ( SELECT 'place'::text AS kind, p.id
      FROM places p, params
      WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND p.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'place')
        AND params.q IS NULL
        AND params.origin IS NULL
      ORDER BY (
        SELECT count(*) FROM bookings b
        JOIN experience_slots s ON s.id = b.slot_id
        JOIN experiences e ON e.id = s.experience_id
        WHERE e.place_id = p.id AND b.status IN ('pending', 'confirmed')
      ) DESC, p.id
      LIMIT 200 )
    UNION ALL
    ( SELECT 'experience'::text AS kind, e.id
      FROM experiences e, params
      WHERE e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND e.status = 'published'
        AND (p_kind IS NULL OR p_kind = 'experience')
        AND (p_category_id IS NULL OR e.category_id = p_category_id)
        AND NOT (e.id = ANY(params.exclude_ids))
        AND params.q IS NULL
        AND params.origin IS NULL
      ORDER BY (
        SELECT count(*) FROM bookings b
        JOIN experience_slots s ON s.id = b.slot_id
        WHERE s.experience_id = e.id AND b.status IN ('pending', 'confirmed')
      ) DESC, e.id
      LIMIT 200 )
  ),
  distinct_ids AS (
    SELECT DISTINCT kind, id FROM candidates
  ),
  signals AS (
    SELECT
      c.kind,
      p.id AS id,
      CASE WHEN params.tsq IS NOT NULL AND p.fts @@ params.tsq
           THEN ts_rank_cd(p.fts, params.tsq) ELSE 0 END AS raw_text,
      CASE WHEN p_embedding IS NOT NULL AND p.embedding IS NOT NULL AND NOT p.embedding_stale
           THEN 1 - (p.embedding <=> p_embedding) ELSE 0 END AS raw_sem,
      CASE WHEN params.origin IS NOT NULL
           THEN ST_Distance(p.geog, params.origin) END AS distance_m,
      (
        SELECT count(*) FROM bookings b
        JOIN experience_slots s ON s.id = b.slot_id
        JOIN experiences e ON e.id = s.experience_id
        WHERE e.place_id = p.id AND b.status IN ('pending', 'confirmed')
      )::double precision AS raw_pop
    FROM distinct_ids c
    JOIN places p ON c.kind = 'place' AND p.id = c.id
    CROSS JOIN params
    WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND p.status = 'published'
      AND (params.origin IS NULL OR ST_DWithin(p.geog, params.origin, p_radius_m))
    UNION ALL
    SELECT
      c.kind,
      e.id AS id,
      CASE WHEN params.tsq IS NOT NULL AND e.fts @@ params.tsq
           THEN ts_rank_cd(e.fts, params.tsq) ELSE 0 END AS raw_text,
      CASE WHEN p_embedding IS NOT NULL AND e.embedding IS NOT NULL AND NOT e.embedding_stale
           THEN 1 - (e.embedding <=> p_embedding) ELSE 0 END AS raw_sem,
      CASE WHEN params.origin IS NOT NULL
           THEN ST_Distance(pl.geog, params.origin) END AS distance_m,
      (
        SELECT count(*) FROM bookings b
        JOIN experience_slots s ON s.id = b.slot_id
        WHERE s.experience_id = e.id AND b.status IN ('pending', 'confirmed')
      )::double precision AS raw_pop
    FROM distinct_ids c
    JOIN experiences e ON c.kind = 'experience' AND e.id = c.id
    JOIN places pl ON pl.id = e.place_id
    CROSS JOIN params
    WHERE e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND e.status = 'published'
      AND NOT (e.id = ANY(params.exclude_ids))
      AND (p_category_id IS NULL OR e.category_id = p_category_id)
      AND (params.origin IS NULL OR ST_DWithin(pl.geog, params.origin, p_radius_m))
  ),
  scored AS (
    SELECT
      s.kind, s.id, s.distance_m,
      CASE WHEN max(s.raw_text) OVER () = min(s.raw_text) OVER () THEN 0
           ELSE (s.raw_text - min(s.raw_text) OVER ())
                / nullif(max(s.raw_text) OVER () - min(s.raw_text) OVER (), 0) END AS n_text,
      CASE WHEN max(s.raw_sem) OVER () = min(s.raw_sem) OVER () THEN 0
           ELSE (s.raw_sem - min(s.raw_sem) OVER ())
                / nullif(max(s.raw_sem) OVER () - min(s.raw_sem) OVER (), 0) END AS n_sem,
      CASE WHEN max(s.raw_pop) OVER () = min(s.raw_pop) OVER () THEN 0
           ELSE (s.raw_pop - min(s.raw_pop) OVER ())
                / nullif(max(s.raw_pop) OVER () - min(s.raw_pop) OVER (), 0) END AS n_pop,
      CASE WHEN p_lng IS NULL OR p_lat IS NULL THEN 1
           ELSE exp(-coalesce(s.distance_m, 0) / 5000.0) END AS n_geo
    FROM signals s
  ),
  final AS (
    SELECT
      scored.kind,
      scored.id,
      scored.distance_m,
      p_w_text * scored.n_text
        + p_w_sem * scored.n_sem
        + p_w_geo * scored.n_geo
        + p_w_pop * scored.n_pop AS score
    FROM scored
  )
  SELECT final.kind, final.id, final.score, final.distance_m
  FROM final
  WHERE p_after_id IS NULL OR (final.score, final.id) < (p_after_score, p_after_id)
  ORDER BY final.score DESC, final.id
  LIMIT p_max_rows;
$$;
`);

  pgm.sql(`
REVOKE ALL ON FUNCTION search_hybrid(
  text, vector, double precision, double precision, double precision, text,
  uuid, uuid[], double precision, double precision, double precision,
  double precision, double precision, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_hybrid(
  text, vector, double precision, double precision, double precision, text,
  uuid, uuid[], double precision, double precision, double precision,
  double precision, double precision, uuid, integer
) TO tusk_app;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`
DROP FUNCTION IF EXISTS search_hybrid(
  text, vector, double precision, double precision, double precision, text,
  uuid, uuid[], double precision, double precision, double precision,
  double precision, double precision, uuid, integer
);
`);
};
