/**
 * Phase 2: spatial candidate functions.
 *
 * WHY these exist (Postgres 16.4+ / CVE-2024-10976 behavior):
 * a qual can only become an index condition on an RLS-protected table if its
 * underlying function is LEAKPROOF. The PostGIS operators (`&&`,
 * `ST_DWithin`, `ST_Intersects`) are not leakproof, so with `FORCE RLS` the
 * planner cannot use `places_geog_gix` for `tusk_app` — near-me queries
 * degrade to a seq scan (measured: 0.3 ms vs ~100 ms on 5k rows, see
 * docs/perf/phase2-places.md).
 *
 * These SECURITY DEFINER functions are owned by `tusk_migrator` (BYPASSRLS),
 * so inside them the GiST index is usable again. Safety measures:
 * - the tenant is read from the same `app.tenant_id` GUC the RLS policies
 *   use (set transaction-locally by the API from the JWT; clients cannot
 *   set GUCs) — never from a function argument;
 * - only `status = 'published'` rows are returned (TR-SEC-004);
 * - EXECUTE is revoked from PUBLIC and granted only to `tusk_app`;
 * - the API re-fetches the returned ids through normal RLS queries, so the
 *   policies still gate every row that reaches a response.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
CREATE FUNCTION place_ids_within_radius(
  lng              double precision,
  lat              double precision,
  radius_m         double precision,
  after_distance_m integer,
  after_id         uuid,
  max_rows         integer
)
RETURNS TABLE (place_id uuid, distance_m integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH origin AS (
    SELECT ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography AS point
  )
  SELECT p.id AS place_id,
         round(ST_Distance(p.geog, origin.point))::int AS distance_m
  FROM places p, origin
  WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND p.status = 'published'
    AND (
      after_id IS NULL
      OR (round(ST_Distance(p.geog, origin.point))::int, p.id) > (after_distance_m, after_id)
    )
    AND ST_DWithin(p.geog, origin.point, radius_m)
  ORDER BY distance_m, place_id
  LIMIT max_rows;
$$;

CREATE FUNCTION place_ids_within_bbox(
  west             double precision,
  south            double precision,
  east             double precision,
  north            double precision,
  after_created_at timestamptz,
  after_id         uuid,
  max_rows         integer
)
RETURNS TABLE (place_id uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH envelope AS (
    SELECT ST_MakeEnvelope(west, south, east, north, 4326)::geography AS geog
  )
  SELECT p.id AS place_id, p.created_at
  FROM places p, envelope
  WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND p.status = 'published'
    AND (
      after_id IS NULL
      OR (p.created_at, p.id) < (after_created_at, after_id)
    )
    AND p.geog && envelope.geog
    AND ST_Intersects(p.geog, envelope.geog)
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT max_rows;
$$;
`);

  pgm.sql(`
REVOKE ALL ON FUNCTION place_ids_within_radius(double precision, double precision, double precision, integer, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION place_ids_within_bbox(double precision, double precision, double precision, double precision, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION place_ids_within_radius(double precision, double precision, double precision, integer, uuid, integer) TO tusk_app;
GRANT EXECUTE ON FUNCTION place_ids_within_bbox(double precision, double precision, double precision, double precision, timestamptz, uuid, integer) TO tusk_app;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`
DROP FUNCTION IF EXISTS place_ids_within_radius(double precision, double precision, double precision, integer, uuid, integer);
DROP FUNCTION IF EXISTS place_ids_within_bbox(double precision, double precision, double precision, double precision, timestamptz, uuid, integer);
`);
};
