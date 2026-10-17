import type { TransactionSql } from "postgres";
import { encodeCursor, type Cursor } from "../../lib/cursor.js";
import { AppError } from "../../lib/errors.js";
import { getExperience } from "./experiences.service.js";

export type BookingStatus = "pending" | "confirmed" | "cancelled";

export type BookingRow = {
  id: string;
  tenant_id: string;
  slot_id: string;
  user_id: string;
  party_size: number;
  status: BookingStatus;
  version: number;
  amount_minor: number;
  currency: string;
  external_payment_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type CreateBookingInput = {
  tenantId: string;
  experienceId: string;
  slotId: string;
  userId: string;
  partySize: number;
  idempotencyKey: string;
  requestHash: string;
  externalPaymentId: string | null;
};

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; constraint_name?: unknown };
  return e.code === "23505" && e.constraint_name === constraint;
}

export async function getBooking(
  tx: TransactionSql,
  bookingId: string,
): Promise<BookingRow | null> {
  const rows = await tx<BookingRow[]>`
    SELECT id, tenant_id, slot_id, user_id, party_size, status, version,
           amount_minor, currency, external_payment_id, created_at, updated_at
    FROM bookings
    WHERE id = ${bookingId}
  `;
  return rows[0] ?? null;
}

export type ListBookingsParams = { limit: number; cursor?: Cursor | undefined };

export async function listBookings(
  tx: TransactionSql,
  params: ListBookingsParams,
): Promise<{ items: BookingRow[]; nextCursor: string | null }> {
  const fetch = params.limit + 1;
  const keyset = params.cursor
    ? tx`AND (created_at, id) < (${params.cursor.t!}::timestamptz, ${params.cursor.id}::uuid)`
    : tx``;
  const rows = await tx<BookingRow[]>`
    SELECT id, tenant_id, slot_id, user_id, party_size, status, version,
           amount_minor, currency, external_payment_id, created_at, updated_at
    FROM bookings
    WHERE true
      ${keyset}
    ORDER BY created_at DESC, id DESC
    LIMIT ${fetch}
  `;
  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

/**
 * TRD §9. Invariant: sum(active bookings.party_size) <= slot.capacity.
 *
 * Concurrency: `pg_advisory_xact_lock` on the slot id (TRD §9's alternative to
 * a row lock). A `SELECT ... FOR UPDATE` on the slot is NOT usable here: under
 * RLS a locking select also applies the UPDATE policy, which is host/admin
 * only, so an explorer's lock would see zero rows and every booking would 404.
 * The advisory lock is held until commit and serialises bookings per slot; the
 * count then runs inside the lock. The count goes through
 * `slot_active_party_size` (SECURITY DEFINER) because the bookings SELECT
 * policy hides other users' rows from the caller (see the migration) — counting
 * via RLS would always see only the caller's bookings and oversell. The partial
 * unique index is the second guard for FR-EXP-008.
 */
export async function createBooking(
  tx: TransactionSql,
  input: CreateBookingInput,
): Promise<{ booking: BookingRow; replayed: boolean }> {
  // FR-EXP-009/010: one tenant-scoped row per key. The insert is the lock:
  // a concurrent replay blocks on the unique index until the first tx commits.
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO idempotency_keys (tenant_id, key, request_hash)
    VALUES (${input.tenantId}, ${input.idempotencyKey}, ${input.requestHash})
    ON CONFLICT (tenant_id, key) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    const existing = await tx<{ request_hash: string; booking_id: string | null }[]>`
      SELECT request_hash, booking_id
      FROM idempotency_keys
      WHERE tenant_id = ${input.tenantId} AND key = ${input.idempotencyKey}
      FOR UPDATE
    `;
    const key = existing[0];
    if (!key || key.request_hash !== input.requestHash) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "Idempotency-Key was reused with a different request",
      );
    }
    if (!key.booking_id) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "A request with this Idempotency-Key is already in progress",
      );
    }
    const booking = await getBooking(tx, key.booking_id);
    if (!booking) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "The original booking for this Idempotency-Key is no longer visible",
      );
    }
    return { booking, replayed: true };
  }

  const experience = await getExperience(tx, input.experienceId);
  if (!experience || experience.status !== "published") {
    throw new AppError("NOT_FOUND", 404, "Experience not found");
  }

  // Serialise concurrent bookings for this slot; released at commit/rollback.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.slotId}::text, 0))`;

  const slotRows = await tx<{ id: string; capacity: number; status: string; bookable: boolean }[]>`
    SELECT id, capacity, status,
           (upper_inf(during) OR upper(during) > now()) AS bookable
    FROM experience_slots
    WHERE id = ${input.slotId} AND experience_id = ${input.experienceId}
  `;
  const slot = slotRows[0];
  if (!slot) {
    throw new AppError("NOT_FOUND", 404, "Slot not found");
  }
  if (slot.status !== "open") {
    throw new AppError("BOOKING_CONFLICT", 409, "Slot is not open for booking");
  }
  if (!slot.bookable) {
    throw new AppError("SLOT_IN_PAST", 400, "Slot is in the past");
  }

  const booked = (
    await tx<{ active: number }[]>`
      SELECT slot_active_party_size(${input.slotId}) AS active
    `
  )[0]!;
  if (booked.active + input.partySize > slot.capacity) {
    throw new AppError("BOOKING_CAPACITY", 409, "Not enough capacity remaining");
  }

  const already = await tx<{ id: string }[]>`
    SELECT id FROM bookings
    WHERE slot_id = ${input.slotId} AND user_id = ${input.userId}
      AND status IN ('pending', 'confirmed')
    LIMIT 1
  `;
  if (already.length > 0) {
    throw new AppError(
      "BOOKING_CONFLICT",
      409,
      "You already have a booking for this slot",
    );
  }

  let booking: BookingRow;
  try {
    const rows = await tx<BookingRow[]>`
      INSERT INTO bookings (
        tenant_id, slot_id, user_id, party_size, status,
        amount_minor, currency, external_payment_id
      )
      VALUES (
        ${input.tenantId}, ${input.slotId}, ${input.userId}, ${input.partySize},
        'confirmed', ${experience.price_minor}, ${experience.currency},
        ${input.externalPaymentId}
      )
      RETURNING id, tenant_id, slot_id, user_id, party_size, status, version,
                amount_minor, currency, external_payment_id,
                created_at, updated_at
    `;
    booking = rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, "bookings_slot_user_active_unique")) {
      throw new AppError(
        "BOOKING_CONFLICT",
        409,
        "You already have a booking for this slot",
      );
    }
    throw error;
  }

  await tx`
    UPDATE idempotency_keys SET booking_id = ${booking.id}
    WHERE tenant_id = ${input.tenantId} AND key = ${input.idempotencyKey}
  `;
  return { booking, replayed: false };
}

/** FR-EXP-011: cancel via status; the UPDATE policy gates who may. */
export async function cancelBooking(
  tx: TransactionSql,
  bookingId: string,
): Promise<BookingRow | null> {
  const rows = await tx<BookingRow[]>`
    UPDATE bookings
    SET status = 'cancelled',
        version = version + CASE WHEN status = 'cancelled' THEN 0 ELSE 1 END
    WHERE id = ${bookingId}
    RETURNING id, tenant_id, slot_id, user_id, party_size, status, version,
              amount_minor, currency, external_payment_id,
              created_at, updated_at
  `;
  return rows[0] ?? null;
}

export function toBookingDto(row: BookingRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slotId: row.slot_id,
    userId: row.user_id,
    partySize: row.party_size,
    status: row.status,
    version: row.version,
    amountMinor: row.amount_minor,
    currency: row.currency,
    externalPaymentId: row.external_payment_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
