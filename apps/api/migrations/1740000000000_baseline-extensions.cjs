/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/**
 * Phase 0 baseline: assert extensions (created by Compose init / superuser)
 * and apply app grants. Roles/passwords are not managed here.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(req, ', ')
    INTO missing
  FROM unnest(ARRAY['postgis', 'vector', 'pg_trgm', 'pg_stat_statements', 'pgcrypto']) AS req
  WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = req);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'required extensions missing: %. Create them as superuser (Compose init) before migrating.',
      missing;
  END IF;
END $$;
`);

  // pg_cron is created in Compose init when available. Migrator cannot read
  // shared_preload_libraries, so we only NOTICE if it is still missing.
  pgm.sql(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE
      'pg_cron is available but not installed; create it as superuser (Compose init).';
  END IF;
END $$;
`);

  pgm.sql(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tusk_migrator')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tusk_app') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO tusk_migrator', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO tusk_app', current_database());
    GRANT USAGE, CREATE ON SCHEMA public TO tusk_migrator;
    GRANT USAGE ON SCHEMA public TO tusk_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE tusk_migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tusk_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE tusk_migrator IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO tusk_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tusk_migrator') THEN
    GRANT USAGE ON SCHEMA cron TO tusk_migrator;
  END IF;
END $$;
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`SELECT 1`);
};
