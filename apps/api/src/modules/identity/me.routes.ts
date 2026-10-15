import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { authOf } from "../../http/plugins/auth.js";
import { AppError } from "../../lib/errors.js";
import { MembershipDto, Meta, UserDto } from "./dto.js";
import {
  findUserById,
  listMembershipsWithTenant,
  toMembershipDto,
  toUserDto,
} from "./identity.service.js";

type MeRoutesOpts = { db: Db };

export const meRoutes: FastifyPluginAsyncTypebox<MeRoutesOpts> = async (
  app,
  opts,
) => {
  app.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: Type.Object({
            data: Type.Object({
              user: UserDto,
              memberships: Type.Array(MembershipDto),
              activeTenant: Type.Union([MembershipDto, Type.Null()]),
            }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);

      const data = await withRls(
        opts.db,
        { userId: auth.userId, tenantId: auth.tenantId, role: auth.role },
        async (tx) => {
          const user = await findUserById(tx, auth.userId);
          if (!user) {
            throw new AppError(
              "UNAUTHENTICATED",
              401,
              "Account no longer exists",
            );
          }
          const memberships = await listMembershipsWithTenant(tx, auth.userId);
          const active = auth.tenantId
            ? (memberships.find((m) => m.tenant_id === auth.tenantId) ?? null)
            : null;
          return {
            user,
            memberships,
            activeTenant: active,
          };
        },
      );

      return reply.send({
        data: {
          user: toUserDto(data.user),
          memberships: data.memberships.map(toMembershipDto),
          activeTenant: data.activeTenant
            ? toMembershipDto(data.activeTenant)
            : null,
        },
        meta: { requestId: request.requestId },
      });
    },
  );
};

export default meRoutes;
