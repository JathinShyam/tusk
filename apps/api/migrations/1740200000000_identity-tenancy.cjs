/**
 * Phase 1: identity, tenancy, forced RLS.
 *
 * Tables: tenants, users, memberships, refresh_tokens.
 *
 * RLS decisions (documents what is enforced vs. what lives in the app):
 * - `tenants` and `memberships` are tenant-scoped -> ENABLE + FORCE RLS.
 * - `users` and `refresh_tokens` are global auth tables with no tenant_id:
 *   login/refresh look them up before any tenant context exists, so a policy
 *   keyed on app.tenant_id could not work. They keep DML grants only to
 *   `tusk_app` (no BYPASSRLS) and are only reachable through parameterized SQL.
 * - `app.bootstrap` is set exclusively by provisioning code paths
 *   (self-serve register when ALLOW_SELF_TENANT=true, platform tenant create)
 *   to insert the first tenant/membership. Clients cannot set GUCs.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  slug       text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$' AND length(slug) <= 63),
  type       text NOT NULL DEFAULT 'city' CHECK (type IN ('city', 'brand', 'enterprise')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_slug_unique ON tenants (slug);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  email             text NOT NULL CHECK (position('@' IN email) > 1),
  password_hash     text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Global identity: email unique case-insensitively (TRD §7 decision).
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('explorer', 'host', 'tenant_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_tenant_user_unique ON memberships (tenant_id, user_id);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refresh_tokens_hash_unique ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
`);

  pgm.sql(`
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER refresh_tokens_updated_at BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`);

  pgm.sql(`
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- Members read their own tenant; platform admins read tenant rows (they
-- provision them). Platform admin has no implicit access to tenant *data*.
-- Note: after a SET LOCAL reverts, custom GUCs read as '' (not NULL) on the
-- session, so every uuid cast goes through nullif(..., '') to stay safe on
-- pooled connections.
CREATE POLICY tenants_select ON tenants FOR SELECT
  USING (
    id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.role', true) = 'platform_admin'
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.tenant_id = tenants.id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );

-- Tenants are created by platform admins or by the gated self-serve bootstrap.
CREATE POLICY tenants_insert ON tenants FOR INSERT
  WITH CHECK (
    current_setting('app.role', true) = 'platform_admin'
    OR current_setting('app.bootstrap', true) = 'true'
  );

-- Tenant admins patch name/settings of their own active tenant.
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (
    id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) = 'tenant_admin'
    AND status = 'active'
  )
  WITH CHECK (
    id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) = 'tenant_admin'
    AND status = 'active'
  );

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- PRD §8: a user can read their own memberships (needed at login and for
-- GET /v1/me across tenants); tenant_admin can read all memberships in tenant.
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR (
      tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND current_setting('app.role', true) = 'tenant_admin'
    )
  );

-- Invites: tenant_admin attaches an existing user. Bootstrap: the first
-- membership of a freshly provisioned tenant, for the provisioning user only.
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      current_setting('app.role', true) = 'tenant_admin'
      OR (
        current_setting('app.bootstrap', true) = 'true'
        AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
      )
    )
  );
`);

  pgm.sql(`
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO tusk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO tusk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO tusk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO tusk_app;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // CASCADE: the tenants_select policy subquery depends on memberships, and
  // memberships has FKs back to tenants/users — plain DROP order is circular.
  pgm.sql(`
DROP TABLE IF EXISTS refresh_tokens, memberships, users, tenants CASCADE;
`);
};
