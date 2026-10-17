/**
 * Phase 3: experiences, slots, bookings (FR-EXP-001..014, TRD §7, §9).
 *
 * Tenant consistency is enforced with composite FKs `(tenant_id, parent_id)`,
 * which need a unique `(tenant_id, id)` on each parent (id is already the PK;
 * the extra index is what Postgres requires). Child rows therefore cannot
 * point at another tenant's parent, regardless of what the API does.
 *
 * Slot overlap (FR-EXP-004) is a race-safe exclusion constraint, which needs
 * `btree_gist` for the `experience_id WITH =` part. Capacity is NOT a
 * constraint (TRD §9): it is the `FOR UPDATE` + count in the API, counted
 * through `slot_active_party_size` below.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // btree_gist is a trusted extension; the migrator role needs CREATE on the
  // database (Compose init grants it). Compose init also pre-creates it.
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);

  pgm.sql(`
CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES categories(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Siblings are unique; coalesce() because NULL parent_id would otherwise be
-- "distinct" every time and let duplicates through.
CREATE UNIQUE INDEX categories_tenant_parent_name_unique
  ON categories (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE UNIQUE INDEX categories_tenant_id_unique ON categories (tenant_id, id);
CREATE INDEX categories_parent_idx ON categories (parent_id);

CREATE UNIQUE INDEX places_tenant_id_unique ON places (tenant_id, id);

CREATE TABLE experiences (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  place_id     uuid NOT NULL,
  host_user_id uuid NOT NULL REFERENCES users(id),
  category_id  uuid,
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  description  text,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published', 'archived')),
  price_minor  integer NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency     char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  attrs        jsonb NOT NULL DEFAULT '{}'::jsonb
               CHECK (jsonb_typeof(attrs) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, place_id) REFERENCES places (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);
CREATE UNIQUE INDEX experiences_tenant_id_unique ON experiences (tenant_id, id);
CREATE INDEX experiences_tenant_created_idx
  ON experiences (tenant_id, created_at DESC, id DESC);
CREATE INDEX experiences_attrs_gin ON experiences USING gin (attrs);

CREATE TABLE experience_slots (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experience_id uuid NOT NULL,
  during        tstzrange NOT NULL CHECK (NOT isempty(during)),
  capacity      integer NOT NULL CHECK (capacity >= 1),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, experience_id) REFERENCES experiences (tenant_id, id),
  -- FR-EXP-004: overlapping open slots for the same experience are impossible.
  CONSTRAINT experience_slots_no_overlap EXCLUDE USING gist (
    experience_id WITH =, during WITH &&
  ) WHERE (status = 'open')
);
CREATE UNIQUE INDEX experience_slots_tenant_id_unique ON experience_slots (tenant_id, id);
CREATE INDEX experience_slots_during_gix ON experience_slots USING gist (during);

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slot_id             uuid NOT NULL,
  user_id             uuid NOT NULL REFERENCES users(id),
  party_size          integer NOT NULL CHECK (party_size >= 1),
  status              text NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  version             integer NOT NULL DEFAULT 1,
  amount_minor        integer NOT NULL CHECK (amount_minor >= 0),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  external_payment_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES experience_slots (tenant_id, id)
);
CREATE INDEX bookings_slot_idx ON bookings (slot_id);
-- FR-EXP-008: at most one active booking per user per slot.
CREATE UNIQUE INDEX bookings_slot_user_active_unique
  ON bookings (slot_id, user_id) WHERE status IN ('pending', 'confirmed');
CREATE INDEX bookings_user_created_idx ON bookings (user_id, created_at DESC, id DESC);
CREATE INDEX bookings_tenant_created_idx ON bookings (tenant_id, created_at DESC, id DESC);

CREATE TABLE idempotency_keys (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (length(key) > 0 AND length(key) <= 255),
  request_hash text NOT NULL,
  booking_id   uuid REFERENCES bookings(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '1 day',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idempotency_keys_tenant_key_unique ON idempotency_keys (tenant_id, key);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
`);

  pgm.sql(`
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER experiences_updated_at BEFORE UPDATE ON experiences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER experience_slots_updated_at BEFORE UPDATE ON experience_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER idempotency_keys_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`);

  pgm.sql(`
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;

-- Categories are shared reference data: every member reads, admins write.
CREATE POLICY categories_select ON categories FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY categories_insert ON categories FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) = 'tenant_admin'
  );
CREATE POLICY categories_update ON categories FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) = 'tenant_admin'
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) = 'tenant_admin'
  );

ALTER TABLE experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiences FORCE ROW LEVEL SECURITY;

-- TR-SEC-004, same shape as places: published for every member, drafts and
-- archived only to the owning host or a tenant admin.
CREATE POLICY experiences_select ON experiences FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      status = 'published'
      OR host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
    )
  );
CREATE POLICY experiences_insert ON experiences FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) IN ('host', 'tenant_admin')
    AND (
      host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
    )
  );
CREATE POLICY experiences_update ON experiences FOR UPDATE
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

ALTER TABLE experience_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_slots FORCE ROW LEVEL SECURITY;

-- Slots inherit the visibility of their experience (the EXISTS subquery is
-- itself RLS-filtered), so members never see slots of someone else's draft.
CREATE POLICY experience_slots_select ON experience_slots FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM experiences e WHERE e.id = experience_id)
  );
CREATE POLICY experience_slots_insert ON experience_slots FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.role', true) IN ('host', 'tenant_admin')
    AND EXISTS (
      SELECT 1 FROM experiences e
      WHERE e.id = experience_id
        AND (
          e.host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
          OR current_setting('app.role', true) = 'tenant_admin'
        )
    )
  );
CREATE POLICY experience_slots_update ON experience_slots FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM experiences e
      WHERE e.id = experience_id
        AND (
          e.host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
          OR current_setting('app.role', true) = 'tenant_admin'
        )
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM experiences e
      WHERE e.id = experience_id
        AND (
          e.host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
          OR current_setting('app.role', true) = 'tenant_admin'
        )
    )
  );

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;

-- FR-EXP-012: explorers see their own bookings, hosts see bookings on their
-- experiences, tenant admins see the tenant.
CREATE POLICY bookings_select ON bookings FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
      OR EXISTS (
        SELECT 1
        FROM experience_slots s
        JOIN experiences e ON e.id = s.experience_id
        WHERE s.id = slot_id
          AND e.host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      )
    )
  );
-- FR-EXP-012: a user books only for themselves.
CREATE POLICY bookings_insert ON bookings FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
-- FR-EXP-011: cancel by the booker, the experience host, or a tenant admin.
-- Predicate mirrors bookings_select, so cancelling is the same set as seeing.
CREATE POLICY bookings_update ON bookings FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
      OR EXISTS (
        SELECT 1
        FROM experience_slots s
        JOIN experiences e ON e.id = s.experience_id
        WHERE s.id = slot_id
          AND e.host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      )
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR current_setting('app.role', true) = 'tenant_admin'
      OR EXISTS (
        SELECT 1
        FROM experience_slots s
        JOIN experiences e ON e.id = s.experience_id
        WHERE s.id = slot_id
          AND e.host_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

-- Internal table: tenant match only, no user-facing reads/writes.
CREATE POLICY idempotency_keys_select ON idempotency_keys FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY idempotency_keys_insert ON idempotency_keys FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY idempotency_keys_update ON idempotency_keys FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
`);

  // TRD §9 capacity count. Why SECURITY DEFINER: the bookings SELECT policy
  // hides other users' rows from the caller, so an explorer counting their own
  // rows would always see room and oversell. Owned by the BYPASSRLS migrator,
  // it reads the same app.tenant_id GUC (never an argument) and only sums
  // active bookings that belong to the caller's tenant.
  pgm.sql(`
CREATE FUNCTION slot_active_party_size(p_slot_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(b.party_size), 0)::int
  FROM bookings b
  WHERE b.slot_id = p_slot_id
    AND b.status IN ('pending', 'confirmed')
    AND b.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION slot_active_party_size(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION slot_active_party_size(uuid) TO tusk_app;
`);

  // No DELETE anywhere: bookings cancel via status, experiences archive via
  // status. The app role can never physically remove a row.
  pgm.sql(`
GRANT SELECT, INSERT, UPDATE ON categories TO tusk_app;
GRANT SELECT, INSERT, UPDATE ON experiences TO tusk_app;
GRANT SELECT, INSERT, UPDATE ON experience_slots TO tusk_app;
GRANT SELECT, INSERT, UPDATE ON bookings TO tusk_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO tusk_app;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS slot_active_party_size(uuid);`);
  pgm.sql(`
DROP TABLE IF EXISTS
  idempotency_keys, bookings, experience_slots, experiences, categories
CASCADE;
`);
  pgm.sql(`DROP INDEX IF EXISTS places_tenant_id_unique;`);
};
