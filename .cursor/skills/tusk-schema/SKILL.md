---
name: tusk-schema
description: Designs and migrates Tusk PostgreSQL schema (PostGIS, pgvector, tsvector, JSONB, UNLOGGED, partitions, constraints). Use when creating tables, indexes, extensions, generated columns, or SQL migrations.
---

# Tusk schema

## Instructions

1. Read [TRD §7](../../../docs/TRD.md) and the feature PRD for the entity.
2. Follow [reference.md](reference.md) for column/index/RLS templates.
3. One migration per coherent change. Same migration as: table + indexes + RLS + grants to `tusk_app`.
4. Do not add Redis/ES tables. Do not use Prisma.

## Required on every tenant table

- `id uuid PRIMARY KEY` (UUIDv7)
- `tenant_id uuid NOT NULL REFERENCES tenants(id)`
- `created_at`, `updated_at timestamptz`
- `ENABLE` + `FORCE ROW LEVEL SECURITY`
- Policy using `current_setting('app.tenant_id', true)::uuid`

## Extension map

| Need | Extension |
|------|-----------|
| Geo | postgis |
| Vectors | vector |
| Trigram (optional boost) | pg_trgm |
| Jobs | pg_cron |
| Crypto | pgcrypto |
| Stats | pg_stat_statements |

## Anti-patterns

- `float` money; `timestamp` without time zone; offset pagination as default
- HNSW in Phase 2 (wait for embeddings in Phase 4)
- UNLOGGED without rebuild SQL

## Additional resources

- [reference.md](reference.md)
- [TRD.md](../../../docs/TRD.md)
