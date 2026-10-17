/**
 * Phase 2: places + geospatial (FR-GEO-001..011, TRD §7).
 *
 * - `places` is tenant-scoped: ENABLE + FORCE RLS, policies below.
 * - `tenants.boundary` is the optional delivery area (FR-GEO-008); the API
 *   checks ST_Covers at insert time. One polygon per tenant is the Phase 2
 *   minimum, so it lives on the tenant row rather than a `zones` table.
 * - No DELETE policy on purpose: FR-GEO-011 archiving is
 *   `UPDATE ... SET status = 'archived'`; the app role can never physically
 *   delete rows.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
ALTER TABLE tenants ADD COLUMN boundary geography(MultiPolygon, 4326);
`);

  pgm.sql(`
CREATE TABLE places (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host_user_id uuid NOT NULL REFERENCES users(id),
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  description  text,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published', 'archived')),
  geog         geography(Point, 4326) NOT NULL,
  attrs        jsonb NOT NULL DEFAULT '{}'::jsonb
               CHECK (jsonb_typeof(attrs) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- FR-GEO-004/006: radius and bbox predicates use the GiST index.
CREATE INDEX places_geog_gix ON places USING gist (geog);
-- FR-GEO-009 / TRD §7.1: JSONB containment filters arrive in Phase 5.
CREATE INDEX places_attrs_gin ON places USING gin (attrs);
-- FR-GEO-010: keyset pagination on (created_at, id).
CREATE INDEX places_tenant_created_idx ON places (tenant_id, created_at DESC, id DESC);
`);

  pgm.sql(`
CREATE TRIGGER places_updated_at BEFORE UPDATE ON places
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`);

  pgm.sql(`
ALTER TABLE places ENABLE ROW LEVEL SECURITY;
ALTER TABLE places FORCE ROW LEVEL SECURITY;

-- TR-SEC-004: published rows visible to every member of the tenant; drafts
-- (and archived rows) only to the owner host or a tenant admin. Same
-- nullif(..., '') GUC pattern as Phase 1 (pooled connections read '' after a
-- reverted SET LOCAL).
CREATE POLICY places_select ON places FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      status = 'published'
      OR host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
    )
  );

-- FR-GEO-002: only hosts/admins create. A host owns what it creates; a
-- tenant_admin may attribute a place to another member.
CREATE POLICY places_insert ON places FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) IN ('host', 'tenant_admin')
    AND (
      host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
    )
  );

-- Publish/archive/edit: owner or tenant_admin. No DELETE policy exists, so
-- physical deletes are impossible for the app role (FR-GEO-011).
CREATE POLICY places_update ON places FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
    )
  );
`);

  pgm.sql(`
GRANT SELECT, INSERT, UPDATE ON places TO tusk_app;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS places CASCADE;`);
  pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS boundary;`);
};
