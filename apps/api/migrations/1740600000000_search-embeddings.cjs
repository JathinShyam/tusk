/**
 * Phase 4: search columns (FR-SRCH-*, TRD §7.1/§7.2, §8).
 *
 * - `fts` is a STORED generated tsvector over title/description, GIN-indexed.
 * - `embedding` is `vector(EMBEDDING_DIM)` (dimension is baked into the column,
 *   so changing the env var means a new migration) + `embedding_stale` so a
 *   failed provider call can be retried later (TR §18).
 * - HNSW cosine indexes; IVFFlat is deliberately not used (ADR in Phase 7).
 *
 * Popularity is NOT a column here: it is a live count of active bookings,
 * computed inside `search_hybrid` (Phase 5 adds reviews/trending MV).
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

const dim = Number(process.env.EMBEDDING_DIM ?? "1536");
if (!Number.isInteger(dim) || dim < 1 || dim > 16_000) {
  throw new Error(`EMBEDDING_DIM must be a positive integer, got: ${process.env.EMBEDDING_DIM}`);
}

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
ALTER TABLE places
  ADD COLUMN fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED,
  ADD COLUMN embedding vector(${dim}),
  ADD COLUMN embedding_stale boolean NOT NULL DEFAULT true;

CREATE INDEX places_fts_gin ON places USING gin (fts);
CREATE INDEX places_embedding_hnsw ON places USING hnsw (embedding vector_cosine_ops);

ALTER TABLE experiences
  ADD COLUMN fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED,
  ADD COLUMN embedding vector(${dim}),
  ADD COLUMN embedding_stale boolean NOT NULL DEFAULT true;

CREATE INDEX experiences_fts_gin ON experiences USING gin (fts);
CREATE INDEX experiences_embedding_hnsw ON experiences USING hnsw (embedding vector_cosine_ops);
`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`
DROP INDEX IF EXISTS places_fts_gin;
DROP INDEX IF EXISTS places_embedding_hnsw;
DROP INDEX IF EXISTS experiences_fts_gin;
DROP INDEX IF EXISTS experiences_embedding_hnsw;
ALTER TABLE places DROP COLUMN IF EXISTS fts, DROP COLUMN IF EXISTS embedding, DROP COLUMN IF EXISTS embedding_stale;
ALTER TABLE experiences DROP COLUMN IF EXISTS fts, DROP COLUMN IF EXISTS embedding, DROP COLUMN IF EXISTS embedding_stale;
`);
};
