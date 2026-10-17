import { Type } from "@sinclair/typebox";

export const PlaceDto = Type.Object({
  id: Type.String(),
  tenantId: Type.String(),
  hostUserId: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  lat: Type.Number(),
  lng: Type.Number(),
  /** FR-GEO-005: present (integer metres) only on geo radius queries. */
  distanceM: Type.Optional(Type.Integer()),
  attrs: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
