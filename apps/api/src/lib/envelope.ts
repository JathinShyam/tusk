import { Type } from "@sinclair/typebox";

/** TRD §10.1 response envelope pieces shared by all modules. */
export const Meta = Type.Object({ requestId: Type.String() });

/** List responses include the keyset cursor for the next page (or null). */
export const PaginatedMeta = Type.Object({
  requestId: Type.String(),
  pagination: Type.Object({
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  }),
});
