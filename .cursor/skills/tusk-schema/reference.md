# Schema reference

## Tenant table skeleton

```sql
CREATE TABLE places (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  host_user_id uuid REFERENCES users(id),
  title       text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published', 'archived')),
  geog        geography(Point, 4326) NOT NULL,
  attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX places_geog_gix ON places USING gist (geog);
CREATE INDEX places_attrs_gin ON places USING gin (attrs);

ALTER TABLE places ENABLE ROW LEVEL SECURITY;
ALTER TABLE places FORCE ROW LEVEL SECURITY;

CREATE POLICY places_tenant_isolation ON places
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON places TO tusk_app;
```

Tighten `USING` with status/role in the same migration or a follow-up in Phase 2 (see identity PRD). Always keep tenant predicate.

## Generated FTS (Phase 4)

```sql
ALTER TABLE places
  ADD COLUMN fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED;

CREATE INDEX places_fts_gin ON places USING gin (fts);
```

## Vector + HNSW (Phase 4)

```sql
ALTER TABLE places
  ADD COLUMN embedding vector(1536),
  ADD COLUMN embedding_stale boolean NOT NULL DEFAULT true;

CREATE INDEX places_embedding_hnsw
  ON places USING hnsw (embedding vector_cosine_ops);
```

Dimension must match `EMBEDDING_DIM`.

## UNLOGGED cache + rebuild

```sql
CREATE UNLOGGED TABLE place_detail_cache (
  tenant_id uuid NOT NULL,
  place_id  uuid NOT NULL,
  payload   jsonb NOT NULL,
  built_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, place_id)
);

CREATE OR REPLACE FUNCTION rebuild_place_detail_cache()
RETURNS void LANGUAGE sql AS $$
  TRUNCATE place_detail_cache;
  INSERT INTO place_detail_cache (tenant_id, place_id, payload)
  SELECT p.tenant_id, p.id, jsonb_build_object('title', p.title /* extend */);
  -- FROM places p WHERE status = 'published';
$$;
```

## Slot exclusion (Phase 3)

```sql
ALTER TABLE experience_slots
  ADD CONSTRAINT experience_slots_no_overlap
  EXCLUDE USING gist (
    experience_id WITH =,
    during WITH &&
  ) WHERE (status = 'open');
```

Capacity is **not** an exclusion constraint; use `FOR UPDATE` + count (TRD §9).

## Child tenant consistency

Prefer composite FK:

```sql
FOREIGN KEY (tenant_id, place_id) REFERENCES places (tenant_id, id)
```

Requires `UNIQUE (tenant_id, id)` on parent (`id` already unique; add unique on `(tenant_id, id)`).

## Partitions (Phase 6)

```sql
CREATE TABLE activity_events (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE activity_events_2026_08
  PARTITION OF activity_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

RLS must be applied on the parent; test inserts with dates in range.
