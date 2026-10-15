import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { activeTenantId, authOf } from "../../http/plugins/auth.js";
import { AppError } from "../../lib/errors.js";
import { CreatedMembershipDto, Meta, TenantDto, UserDto } from "./dto.js";
import {
  addMembership,
  assertTenantAdmin,
  findUserByEmail,
  getTenant,
  provisionTenant,
  slugify,
  toTenantDto,
  toUserDto,
  updateTenant,
} from "./identity.service.js";
import { PLATFORM_ROLE } from "./tokens.js";

type TenantsRoutesOpts = { db: Db; config: AppConfig };

const CreateTenantBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
  slug: Type.Optional(
    Type.String({ pattern: "^[a-z0-9-]+$", maxLength: 63 }),
  ),
  type: Type.Optional(
    Type.Union([
      Type.Literal("city"),
      Type.Literal("brand"),
      Type.Literal("enterprise"),
    ]),
  ),
});

const PatchTenantBody = Type.Object(
  {
    name: Type.Optional(
      Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
    ),
    settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { minProperties: 1 },
);

const InviteBody = Type.Object({
  email: Type.String({ format: "email", minLength: 3, maxLength: 254 }),
  role: Type.Union([
    Type.Literal("explorer"),
    Type.Literal("host"),
    Type.Literal("tenant_admin"),
  ]),
});

export const tenantsRoutes: FastifyPluginAsyncTypebox<TenantsRoutesOpts> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.post(
    "/platform/tenants",
    {
      preHandler: app.requirePlatformAuth,
      schema: {
        body: CreateTenantBody,
        response: {
          201: Type.Object({
            data: Type.Object({ tenant: TenantDto }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const body = request.body;

      const tenant = await withRls(
        db,
        { userId: auth.userId, role: PLATFORM_ROLE },
        async (tx) => {
          // TR §6: mutating routes re-check the privileged flag in-transaction.
          const admins = await tx<{ is_platform_admin: boolean }[]>`
            SELECT is_platform_admin FROM users WHERE id = ${auth.userId}
          `;
          if (admins[0]?.is_platform_admin !== true) {
            throw new AppError(
              "FORBIDDEN",
              403,
              "Platform admin access required",
            );
          }

          const name = body.name.trim();
          const slug = body.slug ?? slugify(name);
          const created = await provisionTenant(tx, {
            name,
            slug,
            type: body.type,
          });

          // The creator becomes tenant_admin so the new tenant can be
          // administered through the API. The platform_admin *role* still
          // grants no access to tenant data (PRD §4).
          await tx`select set_config('app.bootstrap', 'true', true)`;
          await tx`select set_config('app.user_id', ${auth.userId}, true)`;
          await addMembership(tx, {
            tenantId: created.id,
            userId: auth.userId,
            role: "tenant_admin",
          });
          return created;
        },
      );

      return reply.status(201).send({
        data: { tenant: toTenantDto(tenant) },
        meta: { requestId: request.requestId },
      });
    },
  );

  app.get(
    "/admin/tenant",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        response: {
          200: Type.Object({
            data: Type.Object({ tenant: TenantDto }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);

      const tenant = await withRls(
        db,
        { userId: auth.userId, tenantId, role: auth.role },
        async (tx) => {
          await assertTenantAdmin(tx, tenantId, auth.userId);
          const found = await getTenant(tx, tenantId);
          if (!found) {
            throw new AppError("NOT_FOUND", 404, "Tenant not found");
          }
          if (found.status === "suspended") {
            throw new AppError("TENANT_SUSPENDED", 403, "Tenant is suspended");
          }
          return found;
        },
      );

      return reply.send({
        data: { tenant: toTenantDto(tenant) },
        meta: { requestId: request.requestId },
      });
    },
  );

  app.patch(
    "/admin/tenant",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        body: PatchTenantBody,
        response: {
          200: Type.Object({
            data: Type.Object({ tenant: TenantDto }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);
      const body = request.body;

      const tenant = await withRls(
        db,
        { userId: auth.userId, tenantId, role: auth.role },
        async (tx) => {
          await assertTenantAdmin(tx, tenantId, auth.userId);
          const current = await getTenant(tx, tenantId);
          if (!current) {
            throw new AppError("NOT_FOUND", 404, "Tenant not found");
          }
          if (current.status === "suspended") {
            throw new AppError("TENANT_SUSPENDED", 403, "Tenant is suspended");
          }
          const updated = await updateTenant(tx, tenantId, {
            name: body.name?.trim(),
            settings: body.settings,
          });
          if (!updated) {
            throw new AppError("NOT_FOUND", 404, "Tenant not found");
          }
          return updated;
        },
      );

      return reply.send({
        data: { tenant: toTenantDto(tenant) },
        meta: { requestId: request.requestId },
      });
    },
  );

  app.post(
    "/admin/memberships",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        body: InviteBody,
        response: {
          201: Type.Object({
            data: Type.Object({
              user: UserDto,
              membership: CreatedMembershipDto,
            }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);
      const body = request.body;

      const result = await withRls(
        db,
        { userId: auth.userId, tenantId, role: auth.role },
        async (tx) => {
          await assertTenantAdmin(tx, tenantId, auth.userId);
          const tenant = await getTenant(tx, tenantId);
          if (!tenant) {
            throw new AppError("NOT_FOUND", 404, "Tenant not found");
          }
          if (tenant.status === "suspended") {
            throw new AppError("TENANT_SUSPENDED", 403, "Tenant is suspended");
          }

          // FR-ID-006: the invited user must already exist.
          const user = await findUserByEmail(tx, body.email.trim());
          if (!user) {
            throw new AppError(
              "USER_NOT_FOUND",
              404,
              "No registered user with this email",
            );
          }
          const membership = await addMembership(tx, {
            tenantId,
            userId: user.id,
            role: body.role,
          });
          return { user, membership };
        },
      );

      return reply.status(201).send({
        data: {
          user: toUserDto(result.user),
          membership: {
            id: result.membership.id,
            tenantId: result.membership.tenant_id,
            userId: result.membership.user_id,
            role: result.membership.role,
            createdAt: result.membership.created_at.toISOString(),
          },
        },
        meta: { requestId: request.requestId },
      });
    },
  );
};

export default tenantsRoutes;
