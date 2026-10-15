---
name: tusk-hybrid-search
description: Implements Tusk hybrid search and recommendations (tsvector, pgvector HNSW, PostGIS distance, ranking weights). Use when writing GET /v1/search, embeddings, FTS, HNSW, or recs SQL.
---

# Tusk hybrid search

## Instructions

1. One SQL statement (CTEs/windows OK). Node only: validate params, embed query text, pass `vector` + geo + `q`.
2. Ranking defaults (override from `tenants.settings->'ranking'`):

```
score = 0.35 * text_rank + 0.30 * semantic + 0.20 * geo_decay + 0.15 * popularity
```

3. Follow [reference.md](reference.md) for the CTE shape.
4. Provider down: commit text, `embedding_stale = true`, semantic term = 0. No 5xx.
5. `q` empty and no geo → 400 `SEARCH_UNCONSTRAINED`.

## Embeddings

- Interface: `embed(texts: string[]) => number[][]` with `openai` | `voyage` | `mock`.
- `mock`: deterministic unit-ish vectors from hash (tests).
- Dimension = `EMBEDDING_DIM` = column `vector(N)`.
- On publish/update of title/description: embed in-process (Phase 4). Nightly backfill is Phase 6.

## Indexes

- `GIN(fts)`, `HNSW(embedding vector_cosine_ops)`, `GIST(geog)` — all used in the same query plan when filters apply.
- Do not add IVFFlat unless ADR revisits.

## Recs

Phase 4: nearest neighbor to preference embedding, else trending/geo.  
Phase 7: add co-book collab in SQL; cache UNLOGGED with miss path.

## Additional resources

- [reference.md](reference.md)
- [prd/04-hybrid-search.md](../../../docs/prd/04-hybrid-search.md)
- [prd/05-recommendations.md](../../../docs/prd/05-recommendations.md)
