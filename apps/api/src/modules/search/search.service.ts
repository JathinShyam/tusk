import type { TransactionSql } from "postgres";
import { encodeCursor, type Cursor } from "../../lib/cursor.js";
import { toVectorLiteral } from "./embeddings.js";

export type HitKind = "place" | "experience";

/** FR-SRCH-004: default weights, overridable per tenant. */
export type RankingWeights = {
  text: number;
  sem: number;
  geo: number;
  pop: number;
};

export const DEFAULT_WEIGHTS: RankingWeights = {
  text: 0.35,
  sem: 0.3,
  geo: 0.2,
  pop: 0.15,
};

/** FR-REC-003/004: popularity × distance decay, no text/semantic terms. */
export const RECOMMENDATION_WEIGHTS: RankingWeights = {
  text: 0,
  sem: 0,
  geo: 0.3,
  pop: 0.7,
};

/** FR-SRCH-003 default radius, matching FR-GEO-007. */
export const DEFAULT_RADIUS_M = 3000;

export type SearchParams = {
  q: string;
  embedding: number[] | null;
  lng?: number;
  lat?: number;
  radiusM: number;
  kind?: HitKind;
  categoryId?: string;
  excludeExperienceIds?: string[];
  limit: number;
  cursor?: Cursor;
};

export type SearchHit = {
  kind: HitKind;
  id: string;
  title: string;
  score: number;
  distanceM?: number;
};

export type SearchResult = {
  items: SearchHit[];
  nextCursor: string | null;
};

type RawHit = {
  kind: HitKind;
  id: string;
  score: number;
  distance_m: number | null;
};

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** FR-SRCH-004: read `tenants.settings.ranking` and fall back per key. */
export async function loadRankingWeights(
  tx: TransactionSql,
  tenantId: string,
): Promise<RankingWeights> {
  const rows = await tx<{ ranking: Record<string, unknown> | null }[]>`
    SELECT settings -> 'ranking' AS ranking
    FROM tenants
    WHERE id = ${tenantId}
  `;
  const r = rows[0]?.ranking ?? {};
  return {
    text: numOr(r["text"], DEFAULT_WEIGHTS.text),
    sem: numOr(r["semantic"], DEFAULT_WEIGHTS.sem),
    geo: numOr(r["geo"], DEFAULT_WEIGHTS.geo),
    pop: numOr(r["popularity"], DEFAULT_WEIGHTS.pop),
  };
}

/**
 * Candidate ids + ranking come from the SECURITY DEFINER `search_hybrid`
 * function (GIN/HNSW/GiST are usable there; see the migration for why). Every
 * returned row is then re-read through a normal RLS query, so the policies
 * remain the gate for what can appear in a response.
 */
export async function searchHits(
  tx: TransactionSql,
  params: SearchParams,
  weights: RankingWeights,
): Promise<SearchResult> {
  const exclude = params.excludeExperienceIds ?? [];
  const fetch = params.limit + 1;

  const raw = await tx<RawHit[]>`
    SELECT kind, id, score, distance_m
    FROM search_hybrid(
      ${params.q},
      ${params.embedding ? toVectorLiteral(params.embedding) : null}::vector,
      ${params.lng ?? null},
      ${params.lat ?? null},
      ${params.radiusM},
      ${params.kind ?? null},
      ${params.categoryId ?? null},
      ${exclude.length > 0 ? exclude : null}::uuid[],
      ${weights.text},
      ${weights.sem},
      ${weights.geo},
      ${weights.pop},
      ${params.cursor?.s ?? null},
      ${params.cursor?.id ?? null},
      ${fetch}
    )
  `;

  const hasMore = raw.length > params.limit;
  const page = hasMore ? raw.slice(0, params.limit) : raw;
  const titles = await fetchTitles(tx, page);

  const items: SearchHit[] = [];
  for (const hit of page) {
    const title = titles.get(`${hit.kind}:${hit.id}`);
    // Impossible while the function and the policies apply the same tenant +
    // published filter; a miss only means one of them changed. Skip it rather
    // than 500 so pagination stays intact.
    if (title === undefined) continue;
    items.push({
      kind: hit.kind,
      id: hit.id,
      title,
      score: hit.score,
      ...(hit.distance_m !== null ? { distanceM: Math.round(hit.distance_m) } : {}),
    });
  }

  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor({ s: last.score, id: last.id }) : null,
  };
}

async function fetchTitles(
  tx: TransactionSql,
  hits: RawHit[],
): Promise<Map<string, string>> {
  const placeIds = hits.filter((h) => h.kind === "place").map((h) => h.id);
  const experienceIds = hits
    .filter((h) => h.kind === "experience")
    .map((h) => h.id);
  const titles = new Map<string, string>();
  if (placeIds.length > 0) {
    const rows = await tx<{ id: string; title: string }[]>`
      SELECT id, title FROM places WHERE id = ANY(${placeIds}::uuid[])
    `;
    for (const row of rows) titles.set(`place:${row.id}`, row.title);
  }
  if (experienceIds.length > 0) {
    const rows = await tx<{ id: string; title: string }[]>`
      SELECT id, title FROM experiences WHERE id = ANY(${experienceIds}::uuid[])
    `;
    for (const row of rows) titles.set(`experience:${row.id}`, row.title);
  }
  return titles;
}

/**
 * FR-REC-001..005 (naive): the user-preference embedding is a Phase 5 table, so
 * Phase 4 always takes the fallback — popularity × distance decay when geo is
 * supplied, tenant trending otherwise — excluding already-booked experiences.
 */
export async function recommendationHits(
  tx: TransactionSql,
  params: {
    userId: string;
    lng?: number;
    lat?: number;
    radiusM: number;
    limit: number;
  },
): Promise<SearchHit[]> {
  const booked = await tx<{ experience_id: string }[]>`
    SELECT DISTINCT s.experience_id AS experience_id
    FROM bookings b
    JOIN experience_slots s ON s.id = b.slot_id
    WHERE b.user_id = ${params.userId}
      AND b.status IN ('pending', 'confirmed')
  `;
  const result = await searchHits(
    tx,
    {
      q: "",
      embedding: null,
      ...(params.lng !== undefined && params.lat !== undefined
        ? { lng: params.lng, lat: params.lat }
        : {}),
      radiusM: params.radiusM,
      excludeExperienceIds: booked.map((row) => row.experience_id),
      limit: params.limit,
    },
    RECOMMENDATION_WEIGHTS,
  );
  return result.items;
}
