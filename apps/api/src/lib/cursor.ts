import { AppError } from "./errors.js";

/**
 * Opaque keyset cursor (TRD §10.4): base64url of `{ d?, t?, s?, id }`.
 * - `d` is `distanceM` for distance-ordered lists (near-me),
 * - `t` is `created_at` ISO for recency-ordered lists,
 * - `s` is the float `score` for relevance-ordered lists (search),
 * - lists with a different ordering must reject a foreign cursor shape.
 */
export type Cursor = { d?: number; t?: string; s?: number; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AppError("VALIDATION", 400, "Malformed cursor");
  }
  const c = parsed as Partial<Cursor> | null;
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.id !== "string" ||
    !UUID_RE.test(c.id) ||
    (c.d !== undefined && !Number.isFinite(c.d)) ||
    (c.s !== undefined && !Number.isFinite(c.s)) ||
    (c.t !== undefined &&
      (typeof c.t !== "string" || Number.isNaN(Date.parse(c.t))))
  ) {
    throw new AppError("VALIDATION", 400, "Malformed cursor");
  }
  return c as Cursor;
}
