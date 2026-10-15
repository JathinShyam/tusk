---
name: tusk-rls
description: Implements and audits Tusk row-level security, SET LOCAL session context, and DB roles. Use when writing policies, auth, tenancy, withRls, FORCE RLS, or BYPASSRLS.
---

# Tusk RLS

## App contract

Every request that hits tenant data:

```ts
await sql.begin(async (tx) => {
  await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
  await tx`select set_config('app.user_id', ${userId}, true)`;
  await tx`select set_config('app.role', ${role}, true)`;
  // queries using `tx` only
});
```

`true` = `SET LOCAL` (transaction-scoped). Never session-level `SET` (breaks PgBouncer transaction mode).

JWT `tid` / `sub` / `role` are inputs. Mutating routes re-read `memberships` in this transaction before writes.

## Policy rules

1. `ENABLE` + `FORCE ROW LEVEL SECURITY` on all tenant tables.
2. `tusk_app` has **no** `BYPASSRLS`.
3. Tenant predicate always: `tenant_id = current_setting('app.tenant_id', true)::uuid`.
4. Add role/ownership as `AND` clauses — never replace tenant match.
5. Missing setting: `current_setting(..., true)` is NULL → no rows. Do not use `false` (throws).
6. Cross-tenant UUID: API returns **404**, not 403.

## Policy split (typical)

| Command | USING | WITH CHECK |
|---------|-------|------------|
| SELECT published | tenant + `status = 'published'` OR owner/admin | n/a |
| INSERT | n/a | tenant + caller may create |
| UPDATE | tenant + owner/admin | same |
| DELETE | prefer archive via UPDATE | — |

Use `current_setting('app.role', true)` ∈ `tenant_admin`, `host`, `explorer`.

## Tests (required with policy changes)

- Tenant B GET tenant A id → 404
- Query as `tusk_app` **without** `set_config` → 0 rows
- Host cannot UPDATE another host’s draft

## Forbidden

- Security = only `WHERE tenant_id = $1` in app SQL
- `SET ROLE` per request instead of RLS
- Policies that use `current_user` of the DB login (always `tusk_app`)
