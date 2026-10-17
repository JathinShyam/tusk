import { Type } from "@sinclair/typebox";

export const ExperienceDto = Type.Object({
  id: Type.String(),
  tenantId: Type.String(),
  placeId: Type.String(),
  hostUserId: Type.String(),
  categoryId: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  priceMinor: Type.Integer(),
  currency: Type.String(),
  attrs: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const SlotDto = Type.Object({
  id: Type.String(),
  experienceId: Type.String(),
  startsAt: Type.String(),
  /** Always set by this API; null only for an open-ended range. */
  endsAt: Type.Union([Type.String(), Type.Null()]),
  capacity: Type.Integer(),
  status: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const BookingDto = Type.Object({
  id: Type.String(),
  tenantId: Type.String(),
  slotId: Type.String(),
  userId: Type.String(),
  partySize: Type.Integer(),
  status: Type.String(),
  version: Type.Integer(),
  amountMinor: Type.Integer(),
  currency: Type.String(),
  externalPaymentId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
