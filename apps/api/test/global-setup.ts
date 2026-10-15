import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

/**
 * Integration tests run against a real Postgres (Compose). Migrations are
 * applied here so `pnpm test` works after `docker compose up` without a
 * separate migrate step (CI also migrates; this is then a no-op).
 */
export default async function setup(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_MIGRATE_URL ??
    "postgres://tusk_migrator:tusk_migrator@localhost:5432/tusk";

  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL("../migrations", import.meta.url)),
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
}
