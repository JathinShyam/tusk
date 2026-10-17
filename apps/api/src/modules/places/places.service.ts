import type { JSONValue, TransactionSql } from "postgres";
import { encodeCursor, type Cursor } from "../../lib/cursor.js";
import { AppError } from "../../lib/errors.js";

export type PlaceStatus = "draft" | "published" | "archived";

export type PlaceRow = {
  id: string;
  tenant_id: string;
  host_user_id: string;
  title: string;
  description: string | null;
  status: PlaceStatus;
  lng: number;
  lat: number;
  /** Present only on distance-ordered (lat/lng + radiusM) lists. */
  distance_m?: number;
  attrs: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type CreatePlaceInput = {
  tenantId: string;
  hostUserId: string;
  title: string;
  description: string | null;
  status: "draft" | "published";
  lng: number;
  lat: number;
  attrs: Record<string, unknown>;
};

export type ListPlacesParams = {
  origin?: { lng: number; lat: number } | undefined;
  radiusM?: number | undefined;
  bbox?:
    | { west: number; south: number; east: number; north: number }
    | undefined;
  limit: number;
  cursor?: Cursor | undefined;
};

export type ListPlacesResult = {
  items: PlaceRow[];
  nextCursor: string | null;
};

/** FR-GEO-007 (default 3000 m) lives here so route and SQL agree. */
export const DEFAULT_RADIUS_M = 3000;

export async function createPlace(
  tx: TransactionSql,
  input: CreatePlaceInput,
): Promise<PlaceRow> {
  const rows = await tx<PlaceRow[]>`
    INSERT INTO places (tenant_id, host_user_id, title, description, status, geog, attrs)
    VALUES (
      ${input.tenantId},
      ${input.hostUserId},
      ${input.title},
      ${input.description},
      ${input.status},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${tx.json(input.attrs as JSONValue)}::jsonb
    )
    RETURNING id, tenant_id, host_user_id, title, description, status, attrs,
              ST_X(geog::geometry) AS lng, ST_Y(geog::geometry) AS lat,
              created_at, updated_at
  `;
  return rows[0]!;
}

export async function getPlace(
  tx: TransactionSql,
  placeId: string,
): Promise<PlaceRow | null> {
  const rows = await tx<PlaceRow[]>`
    SELECT id, tenant_id, host_user_id, title, description, status, attrs,
           ST_X(geog::geometry) AS lng, ST_Y(geog::geometry) AS lat,
           created_at, updated_at
    FROM places
    WHERE id = ${placeId}
  `;
  return rows[0] ?? null;
}

/**
 * FR-GEO-008: true when the tenant has a boundary and the point is outside
 * it. Tenants without a boundary accept any point. Caller supplies the
 * tenant context via SET LOCAL, so the tenants policy applies as usual.
 */
export async function isOutsideTenantBoundary(
  tx: TransactionSql,
  tenantId: string,
  lng: number,
  lat: number,
): Promise<boolean> {
  const rows = await tx<{ inside: boolean }[]>`
    SELECT ST_Covers(
             boundary,
             ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
           ) AS inside
    FROM tenants
    WHERE id = ${tenantId} AND boundary IS NOT NULL
  `;
  return rows.length > 0 && rows[0]!.inside !== true;
}

/**
 * Candidate ids come from the SECURITY DEFINER functions (giST-usable; see
 * migration 1740400000000), then the rows are re-read through normal RLS
 * queries — the policies stay the gate for every returned row. Ordering is
 * the candidate order (distance for radius, recency for bbox).
 */
async function fetchPlacesByIds(
  tx: TransactionSql,
  ids: string[],
): Promise<Map<string, PlaceRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<PlaceRow[]>`
    SELECT id, tenant_id, host_user_id, title, description, status, attrs,
           ST_X(geog::geometry) AS lng, ST_Y(geog::geometry) AS lat,
           created_at, updated_at
    FROM places
    WHERE id = ANY(${ids}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

function visibleRow(
  byId: Map<string, PlaceRow>,
  placeId: string,
): PlaceRow {
  // Impossible while the function and the policies apply the same
  // tenant + published filter; a miss means one of them changed.
  const row = byId.get(placeId);
  if (!row) {
    throw new AppError(
      "INTERNAL",
      500,
      "Spatial candidate not visible through RLS",
    );
  }
  return row;
}

/**
 * Published places only (drafts/archived reachable by owner/admin through
 * GET /:id). Radius lists order by distance with a `{ d, id }` cursor; bbox
 * and unfiltered lists order by recency with a `{ t, id }` cursor.
 * Fetches limit + 1 candidates so the caller can detect a next page.
 */
export async function listPlaces(
  tx: TransactionSql,
  params: ListPlacesParams,
): Promise<ListPlacesResult> {
  const { origin, bbox, limit, cursor } = params;
  const fetch = limit + 1;

  if (origin) {
    const candidates = await tx<{ place_id: string; distance_m: number }[]>`
      SELECT place_id, distance_m
      FROM place_ids_within_radius(
        ${origin.lng},
        ${origin.lat},
        ${params.radiusM ?? DEFAULT_RADIUS_M},
        ${cursor?.d ?? null},
        ${cursor?.id ?? null},
        ${fetch}
      )
    `;
    const hasMore = candidates.length > limit;
    const page = hasMore ? candidates.slice(0, limit) : candidates;
    const byId = await fetchPlacesByIds(
      tx,
      page.map((candidate) => candidate.place_id),
    );
    const items = page.map((candidate) => ({
      ...visibleRow(byId, candidate.place_id),
      distance_m: candidate.distance_m,
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ d: last.distance_m, id: last.place_id })
          : null,
    };
  }

  if (bbox) {
    const candidates = await tx<{ place_id: string; created_at: Date }[]>`
      SELECT place_id, created_at
      FROM place_ids_within_bbox(
        ${bbox.west},
        ${bbox.south},
        ${bbox.east},
        ${bbox.north},
        ${cursor?.t ?? null},
        ${cursor?.id ?? null},
        ${fetch}
      )
    `;
    const hasMore = candidates.length > limit;
    const page = hasMore ? candidates.slice(0, limit) : candidates;
    const byId = await fetchPlacesByIds(
      tx,
      page.map((candidate) => candidate.place_id),
    );
    const items = page.map((candidate) =>
      visibleRow(byId, candidate.place_id),
    );
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ t: last.created_at.toISOString(), id: last.place_id })
          : null,
    };
  }

  // Plain recency list: the tenant filter is part of the RLS policy itself,
  // so the planner can use places_tenant_created_idx.
  const recencyKeyset = cursor
    ? tx`AND (created_at, id) < (${cursor.t!}::timestamptz, ${cursor.id}::uuid)`
    : tx``;
  const rows = await tx<PlaceRow[]>`
    SELECT id, tenant_id, host_user_id, title, description, status, attrs,
           ST_X(geog::geometry) AS lng, ST_Y(geog::geometry) AS lat,
           created_at, updated_at
    FROM places
    WHERE status = 'published'
      ${recencyKeyset}
    ORDER BY created_at DESC, id DESC
    LIMIT ${fetch}
  `;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

export function toPlaceDto(row: PlaceRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    hostUserId: row.host_user_id,
    title: row.title,
    description: row.description,
    status: row.status,
    lat: row.lat,
    lng: row.lng,
    ...(row.distance_m !== undefined ? { distanceM: row.distance_m } : {}),
    attrs: row.attrs,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
