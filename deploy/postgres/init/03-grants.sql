GRANT CONNECT ON DATABASE tusk TO tusk_migrator;
GRANT CONNECT ON DATABASE tusk TO tusk_app;

GRANT USAGE, CREATE ON SCHEMA public TO tusk_migrator;
GRANT USAGE ON SCHEMA public TO tusk_app;

-- Migrations may create trusted extensions (e.g. btree_gist in Phase 3).
GRANT CREATE ON DATABASE tusk TO tusk_migrator;

ALTER DEFAULT PRIVILEGES FOR ROLE tusk_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tusk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tusk_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tusk_app;

-- Extensions may create schemas; allow migrator to use cron when present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    GRANT USAGE ON SCHEMA cron TO tusk_migrator;
  END IF;
END $$;
