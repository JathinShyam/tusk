import { Type } from "@sinclair/typebox";

/** FR-SRCH-007: hit shape shared by /search and /recommendations. */
export const SearchHitDto = Type.Object({
  kind: Type.Union([Type.Literal("place"), Type.Literal("experience")]),
  id: Type.String(),
  title: Type.String(),
  score: Type.Number(),
  /** Present only when the query carried geo. */
  distanceM: Type.Optional(Type.Integer()),
});
