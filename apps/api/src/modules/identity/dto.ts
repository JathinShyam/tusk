import { Type } from "@sinclair/typebox";

export { Meta } from "../../lib/envelope.js";

export const UserDto = Type.Object({
  id: Type.String(),
  email: Type.String(),
  isPlatformAdmin: Type.Boolean(),
  createdAt: Type.String(),
});

export const TenantDto = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  type: Type.String(),
  status: Type.String(),
  settings: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const MembershipDto = Type.Object({
  tenantId: Type.String(),
  role: Type.String(),
  tenantName: Type.String(),
  tenantSlug: Type.String(),
  tenantStatus: Type.String(),
});

export const CreatedMembershipDto = Type.Object({
  id: Type.String(),
  tenantId: Type.String(),
  userId: Type.String(),
  role: Type.String(),
  createdAt: Type.String(),
});
