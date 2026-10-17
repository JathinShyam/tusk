# Phase 3 — booking concurrency

**Invariant (TRD §9):** `sum(bookings.party_size where active) <= experience_slots.capacity`.

Oversell is a P0 defect, so this documents exactly what serialises a booking.

## Chosen strategy: transaction advisory lock + count

`createBooking` (`apps/api/src/modules/experiences/bookings.service.ts`) runs, in
one `withRls` transaction:

1. `INSERT INTO idempotency_keys ... ON CONFLICT (tenant_id, key) DO NOTHING`
   — a replay blocks on the unique index until the first transaction commits,
   then returns the stored booking (FR-EXP-009/010).
2. `SELECT pg_advisory_xact_lock(hashtextextended($slotId::text, 0))` — held
   until commit/rollback, so bookings for the same slot serialise. Different
   slots take different locks and run in parallel.
3. Read the slot **without** `FOR UPDATE` (RLS-visible published experience).
4. Reject closed (`BOOKING_CONFLICT`) and past (`SLOT_IN_PAST`) slots.
5. `SELECT slot_active_party_size($slotId)` (SECURITY DEFINER, tenant from the
   `app.tenant_id` GUC) and reject `active + party_size > capacity`
   (`BOOKING_CAPACITY`).
6. Reject a second active booking by the same user (`BOOKING_CONFLICT`), then
   `INSERT` the booking with the price snapshot from the experience.
7. `UPDATE idempotency_keys SET booking_id = ...`.

Cancel is a status `UPDATE`; active capacity excludes `cancelled`, so cancelling
frees the seat (FR-EXP-011).

## Why not `SELECT ... FOR UPDATE` on the slot

TRD §9 offers a row lock **or** an advisory lock. The row lock does not work
under this schema's RLS: a locking select is treated as an update for policy
purposes, so it is also filtered by the `experience_slots_update` policy, which
is host/admin only. An explorer's lock therefore sees **zero** rows and every
booking 404s. Reproduced directly as `tusk_app`:

```sql
-- role=explorer, member of the tenant, experience published
SELECT count(*) FROM (SELECT id FROM experience_slots WHERE id = ... FOR UPDATE) x;   -- 0
SELECT count(*) FROM (SELECT id FROM experience_slots WHERE id = ...) y;            -- 1
```

The advisory lock has no such coupling and is the documented fallback.

## Why the count is `SECURITY DEFINER`

The `bookings_select` policy (FR-EXP-012) hides other users' rows from an
explorer, so `sum(party_size)` run through RLS would count only the caller's own
bookings and oversell. `slot_active_party_size` is owned by the `BYPASSRLS`
migrator role, reads the tenant from the same `app.tenant_id` GUC the policies
use (never an argument), and is `REVOKE`d from `PUBLIC` / granted only to
`tusk_app` — the same pattern as the Phase 2 spatial functions.

## Why not Serializable

Serializable isolation is allowed by TRD §9 but not required; the advisory lock
already gives the invariant with less retry machinery. Not used.

## Supporting indexes

- `experience_slots_no_overlap` (GiST, `experience_id =, during &&`) — FR-EXP-004
  slot overlap, race-safe without app code.
- `bookings_slot_user_active_unique` (partial unique on `(slot_id, user_id)` where
  active) — FR-EXP-008 double-book.
- `bookings_slot_idx`, `idempotency_keys_tenant_key_unique`.

## Tests

`apps/api/test/experiences-bookings.test.ts`:

- TR-TEST-005: two explorers race for `capacity=1` → exactly one `201`, one
  `409 BOOKING_CAPACITY`.
- idempotent replay returns the same booking id; changed body → `409 IDEMPOTENCY_CONFLICT`.
- cancel frees capacity.
- host cannot book for another user even by skipping the API (RLS `42501`);
  no `SET LOCAL` → zero rows.
