/**
 * Phase 1 helpers:
 * - uuidv7(): time-ordered UUIDv7 generator (layout per RFC 9562 §5.7).
 *   Postgres 16 has no built-in uuidv7(), so we generate it in the DB as the
 *   repo contract requires ("IDs UUIDv7 generated in DB, AGENTS.md").
 * - set_updated_at(): trigger function reused by every table with updated_at.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_msec bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  v_bytes bytea;
BEGIN
  -- 48-bit unix time in ms (big-endian) + 80 random bits
  v_bytes := decode(lpad(to_hex(v_msec), 12, '0'), 'hex') || gen_random_bytes(10);
  -- version (0111) and RFC 4122 variant (10xx) nibbles
  v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112);
  v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128);
  RETURN encode(v_bytes, 'hex')::uuid;
END
$$;
`);

  pgm.sql(`
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
`);

  pgm.sql(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tusk_app') THEN
    GRANT EXECUTE ON FUNCTION uuidv7() TO tusk_app;
    GRANT EXECUTE ON FUNCTION set_updated_at() TO tusk_app;
  END IF;
END $$;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS set_updated_at();`);
  pgm.sql(`DROP FUNCTION IF EXISTS uuidv7();`);
};
