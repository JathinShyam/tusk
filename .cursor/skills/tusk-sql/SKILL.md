---
name: tusk-sql
description: Writes Tusk application SQL (transactions, locks, JSONB, CTEs, EXPLAIN). Use when adding queries, bookings concurrency, JSONB filters, or performance work.
---

# Tusk application SQL

## Client

postgres.js tagged templates. Pass JS values as parameters — never string-interpolate SQL.

```ts
sql`select * from places where id = ${id}`;
```

Vectors: use the driver’s array/`sql.array` pattern or `'[1,2,...]'::vector` with a bound string from a serializer. Keep one helper `toVectorLiteral(embedding: number[])`.

## Bookings (invariant: active count ≤ capacity)

```sql
SELECT capacity FROM experience_slots WHERE id = ${slotId} FOR UPDATE;

SELECT coalesce(sum(party_size), 0) FROM bookings
 WHERE slot_id = ${slotId} AND status IN ('pending', 'confirmed');
```

Then insert if `sum + party_size <= capacity`. Same transaction as RLS `set_config`. Comment the invariant.

## JSONB containment

```sql
WHERE payload @> ${json}::jsonb
-- GIN on payload required
```

## Idempotency

`INSERT INTO idempotency_keys ... ON CONFLICT (tenant_id, key) DO NOTHING` then `SELECT`; if existing and hash mismatch → conflict.

## EXPLAIN

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
```

Save under `docs/perf/` from Phase 2 onward for new hot paths.

## Timeouts

`select set_config('statement_timeout', '5000', true)` in `withRls`. Search: `1000` if needed.
