import type { JSONValue, TransactionSql } from "postgres";
import { encodeCursor, type Cursor } from "../../lib/cursor.js";
import { AppError } from "../../lib/errors.js";

export type ExperienceStatus = "draft" | "published" | "archived";
export type SlotStatus = "open" | "closed";

export type ExperienceRow = {
  id: string;
  tenant_id: string;
  place_id: string;
  host_user_id: string;
  category_id: string | null;
  title: string;
  description: string | null;
  status: ExperienceStatus;
  price_minor: number;
  currency: string;
  attrs: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type SlotRow = {
  id: string;
  tenant_id: string;
  experience_id: string;
  capacity: number;
  status: SlotStatus;
  starts_at: Date;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type CreateExperienceInput = {
  tenantId: string;
  placeId: string;
  hostUserId: string;
  categoryId: string | null;
  title: string;
  description: string | null;
  status: "draft" | "published";
  priceMinor: number;
  currency: string;
  attrs: Record<string, unknown>;
};

export type ListExperiencesParams = { limit: number; cursor?: Cursor | undefined };

export type ListExperiencesResult = {
  items: ExperienceRow[];
  nextCursor: string | null;
};

export type CreateSlotInput = {
  tenantId: string;
  experienceId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: "open" | "closed";
};

function isExclusionViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; constraint_name?: unknown };
  return e.code === "23P01" && e.constraint_name === constraint;
}

export async function createExperience(
  tx: TransactionSql,
  input: CreateExperienceInput,
): Promise<ExperienceRow> {
  const rows = await tx<ExperienceRow[]>`
    INSERT INTO experiences (
      tenant_id, place_id, host_user_id, category_id, title, description,
      status, price_minor, currency, attrs
    )
    VALUES (
      ${input.tenantId}, ${input.placeId}, ${input.hostUserId},
      ${input.categoryId}, ${input.title}, ${input.description},
      ${input.status}, ${input.priceMinor}, ${input.currency},
      ${tx.json(input.attrs as JSONValue)}::jsonb
    )
    RETURNING id, tenant_id, place_id, host_user_id, category_id, title,
              description, status, price_minor, currency, attrs,
              created_at, updated_at
  `;
  return rows[0]!;
}

export async function getExperience(
  tx: TransactionSql,
  experienceId: string,
): Promise<ExperienceRow | null> {
  const rows = await tx<ExperienceRow[]>`
    SELECT id, tenant_id, place_id, host_user_id, category_id, title,
           description, status, price_minor, currency, attrs,
           created_at, updated_at
    FROM experiences
    WHERE id = ${experienceId}
  `;
  return rows[0] ?? null;
}

/** Published list (drafts/archived reachable by owner/admin through GET /:id). */
export async function listExperiences(
  tx: TransactionSql,
  params: ListExperiencesParams,
): Promise<ListExperiencesResult> {
  const fetch = params.limit + 1;
  const keyset = params.cursor
    ? tx`AND (created_at, id) < (${params.cursor.t!}::timestamptz, ${params.cursor.id}::uuid)`
    : tx``;
  const rows = await tx<ExperienceRow[]>`
    SELECT id, tenant_id, place_id, host_user_id, category_id, title,
           description, status, price_minor, currency, attrs,
           created_at, updated_at
    FROM experiences
    WHERE status = 'published'
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

export async function createSlot(
  tx: TransactionSql,
  input: CreateSlotInput,
): Promise<SlotRow> {
  try {
    const rows = await tx<SlotRow[]>`
      INSERT INTO experience_slots (tenant_id, experience_id, during, capacity, status)
      VALUES (
        ${input.tenantId}, ${input.experienceId},
        tstzrange(${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, '[)'),
        ${input.capacity}, ${input.status}
      )
      RETURNING id, tenant_id, experience_id, capacity, status,
                lower(during) AS starts_at, upper(during) AS ends_at,
                created_at, updated_at
    `;
    return rows[0]!;
  } catch (error) {
    if (isExclusionViolation(error, "experience_slots_no_overlap")) {
      throw new AppError(
        "SLOT_OVERLAP",
        409,
        "Slot overlaps an existing open slot for this experience",
      );
    }
    throw error;
  }
}

export async function listSlots(
  tx: TransactionSql,
  experienceId: string,
): Promise<SlotRow[]> {
  return tx<SlotRow[]>`
    SELECT id, tenant_id, experience_id, capacity, status,
           lower(during) AS starts_at, upper(during) AS ends_at,
           created_at, updated_at
    FROM experience_slots
    WHERE experience_id = ${experienceId}
    ORDER BY lower(during) ASC, id ASC
  `;
}

export function toExperienceDto(row: ExperienceRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    placeId: row.place_id,
    hostUserId: row.host_user_id,
    categoryId: row.category_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priceMinor: row.price_minor,
    currency: row.currency,
    attrs: row.attrs,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toSlotDto(row: SlotRow) {
  return {
    id: row.id,
    experienceId: row.experience_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    capacity: row.capacity,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
