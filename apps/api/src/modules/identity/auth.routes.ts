import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { authOf } from "../../http/plugins/auth.js";
import { AppError } from "../../lib/errors.js";
import { checkAuthRateLimit } from "../../lib/rate-limit.js";
import { MembershipDto, Meta, TenantDto, UserDto } from "./dto.js";
import {
  addMembership,
  createUser,
  findMembership,
  findUserByEmail,
  findUserById,
  getTenant,
  issueRefreshToken,
  provisionTenant,
  resolveSessionContext,
  slugify,
  toMembershipDto,
  toTenantDto,
  toUserDto,
  type RefreshTokenRow,
  type SessionContext,
  type UserRow,
} from "./identity.service.js";
import {
  equalizeLoginTiming,
  hashPassword,
  verifyPassword,
} from "./password.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
  signAccessToken,
  type Role,
} from "./tokens.js";

type AuthRoutesOpts = { db: Db; config: AppConfig };

const EmailSchema = Type.String({
  format: "email",
  minLength: 3,
  maxLength: 254,
});

const RegisterBody = Type.Object({
  email: EmailSchema,
  password: Type.String({ minLength: 8, maxLength: 128 }),
  tenant: Type.Optional(
    Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
      slug: Type.Optional(
        Type.String({ pattern: "^[a-z0-9-]+$", maxLength: 63 }),
      ),
    }),
  ),
});

const LoginBody = Type.Object({
  email: EmailSchema,
  password: Type.String({ minLength: 8, maxLength: 128 }),
});

const RefreshBody = Type.Object({
  refreshToken: Type.String({ minLength: 20, maxLength: 1024 }),
});

const SwitchTenantBody = Type.Object({
  tenantId: Type.String({ format: "uuid" }),
});

const SessionFields = {
  accessToken: Type.String(),
  refreshToken: Type.String(),
  tokenType: Type.Literal("Bearer"),
  expiresIn: Type.Integer(),
};

const LoginResponse = Type.Object({
  data: Type.Object({
    user: UserDto,
    memberships: Type.Array(MembershipDto),
    activeTenantId: Type.Union([Type.String(), Type.Null()]),
    ...SessionFields,
  }),
  meta: Meta,
});

function sessionData(result: {
  user: UserRow;
  context: SessionContext;
  accessToken: string;
  refreshToken: string;
}) {
  return {
    user: toUserDto(result.user),
    memberships: result.context.memberships.map(toMembershipDto),
    activeTenantId: result.context.tenantId,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export const authRoutes: FastifyPluginAsyncTypebox<AuthRoutesOpts> = async (
  app,
  opts,
) => {
  const { db, config } = opts;

  app.post(
    "/auth/register",
    {
      schema: {
        body: RegisterBody,
        response: {
          201: Type.Object({
            data: Type.Object({
              user: UserDto,
              tenant: Type.Union([TenantDto, Type.Null()]),
              ...SessionFields,
            }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.tenant && !config.allowSelfTenant) {
        throw new AppError(
          "FORBIDDEN",
          403,
          "Self-serve tenant creation is disabled",
        );
      }

      const email = body.email.trim().toLowerCase();
      checkAuthRateLimit(`${request.ip}|register|${email}`);
      const passwordHash = await hashPassword(body.password);

      const result = await withRls(db, {}, async (tx) => {
        const user = await createUser(tx, email, passwordHash);

        let tenant = null;
        let role: Role | null = null;
        if (body.tenant) {
          const name = body.tenant.name.trim();
          const slug = body.tenant.slug ?? slugify(name);
          // Provisioning bootstrap: creates the first tenant + membership for
          // the new user. Gated by ALLOW_SELF_TENANT above.
          await tx`select set_config('app.bootstrap', 'true', true)`;
          await tx`select set_config('app.user_id', ${user.id}, true)`;
          tenant = await provisionTenant(tx, { name, slug });
          await addMembership(tx, {
            tenantId: tenant.id,
            userId: user.id,
            role: "tenant_admin",
          });
          role = "tenant_admin";
        }

        const refresh = await issueRefreshToken(tx, config, {
          userId: user.id,
        });
        const accessToken = await signAccessToken(config, {
          userId: user.id,
          tenantId: tenant?.id ?? null,
          role,
        });
        return { user, tenant, accessToken, refreshToken: refresh.token };
      });

      return reply.status(201).send({
        data: {
          user: toUserDto(result.user),
          tenant: result.tenant ? toTenantDto(result.tenant) : null,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          tokenType: "Bearer" as const,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
        meta: { requestId: request.requestId },
      });
    },
  );

  app.post(
    "/auth/login",
    { schema: { body: LoginBody, response: { 200: LoginResponse } } },
    async (request, reply) => {
      const { email, password } = request.body;
      checkAuthRateLimit(`${request.ip}|login|${email.trim().toLowerCase()}`);

      const user = await findUserByEmail(db, email);
      if (!user) {
        await equalizeLoginTiming(password);
        throw new AppError(
          "INVALID_CREDENTIALS",
          401,
          "Invalid email or password",
        );
      }
      const valid = await verifyPassword(user.password_hash, password);
      if (!valid) {
        throw new AppError(
          "INVALID_CREDENTIALS",
          401,
          "Invalid email or password",
        );
      }

      const result = await withRls(db, {}, async (tx) => {
        await tx`select set_config('app.user_id', ${user.id}, true)`;
        const context = await resolveSessionContext(tx, user);
        const refresh = await issueRefreshToken(tx, config, {
          userId: user.id,
        });
        const accessToken = await signAccessToken(config, {
          userId: user.id,
          tenantId: context.tenantId,
          role: context.role,
        });
        return { user, context, accessToken, refreshToken: refresh.token };
      });

      return reply.send({
        data: sessionData(result),
        meta: { requestId: request.requestId },
      });
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { body: RefreshBody, response: { 200: LoginResponse } } },
    async (request, reply) => {
      const tokenHash = hashRefreshToken(config, request.body.refreshToken);

      const result = await withRls(db, {}, async (tx) => {
        const rows = await tx<RefreshTokenRow[]>`
          SELECT id, user_id, family_id, expires_at, revoked_at
          FROM refresh_tokens
          WHERE token_hash = ${tokenHash}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) {
          return { kind: "invalid" as const };
        }
        if (row.revoked_at !== null) {
          // FR-ID-010: reuse of a rotated token revokes the whole family.
          // Return (instead of throwing) so the revocation commits.
          await tx`
            UPDATE refresh_tokens SET revoked_at = now()
            WHERE family_id = ${row.family_id} AND revoked_at IS NULL
          `;
          return { kind: "reuse" as const };
        }
        if (row.expires_at.getTime() <= Date.now()) {
          return { kind: "expired" as const };
        }

        const user = await findUserById(tx, row.user_id);
        if (!user) {
          return { kind: "invalid" as const };
        }

        await tx`select set_config('app.user_id', ${user.id}, true)`;
        const context = await resolveSessionContext(tx, user);
        const next = await issueRefreshToken(tx, config, {
          userId: user.id,
          familyId: row.family_id,
        });
        await tx`
          UPDATE refresh_tokens
          SET revoked_at = now(), replaced_by_id = ${next.id}
          WHERE id = ${row.id}
        `;
        const accessToken = await signAccessToken(config, {
          userId: user.id,
          tenantId: context.tenantId,
          role: context.role,
        });
        return {
          kind: "ok" as const,
          user,
          context,
          accessToken,
          refreshToken: next.token,
        };
      });

      if (result.kind !== "ok") {
        const message =
          result.kind === "reuse"
            ? "Refresh token reuse detected; session revoked"
            : result.kind === "expired"
              ? "Refresh token expired"
              : "Invalid refresh token";
        throw new AppError("UNAUTHENTICATED", 401, message);
      }

      return reply.send({
        data: sessionData(result),
        meta: { requestId: request.requestId },
      });
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        body: RefreshBody,
        response: {
          200: Type.Object({
            data: Type.Object({ status: Type.Literal("ok") }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const tokenHash = hashRefreshToken(config, request.body.refreshToken);
      await withRls(db, {}, async (tx) => {
        await tx`
          UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        `;
      });
      // Idempotent: unknown or already-revoked tokens still return ok.
      return reply.send({
        data: { status: "ok" as const },
        meta: { requestId: request.requestId },
      });
    },
  );

  app.post(
    "/auth/switch-tenant",
    {
      preHandler: app.requireAuth,
      schema: {
        body: SwitchTenantBody,
        response: {
          200: Type.Object({
            data: Type.Object({
              tenant: TenantDto,
              accessToken: Type.String(),
              tokenType: Type.Literal("Bearer"),
              expiresIn: Type.Integer(),
            }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = request.body.tenantId;

      const result = await withRls(
        db,
        { userId: auth.userId, tenantId },
        async (tx) => {
          const membership = await findMembership(tx, tenantId, auth.userId);
          const tenant = await getTenant(tx, tenantId);
          if (!membership || !tenant) {
            throw new AppError(
              "NO_MEMBERSHIP",
              403,
              "You are not a member of this tenant",
            );
          }
          if (tenant.status === "suspended") {
            throw new AppError("TENANT_SUSPENDED", 403, "Tenant is suspended");
          }
          const accessToken = await signAccessToken(config, {
            userId: auth.userId,
            tenantId,
            role: membership.role,
          });
          return { tenant, accessToken };
        },
      );

      return reply.send({
        data: {
          tenant: toTenantDto(result.tenant),
          accessToken: result.accessToken,
          tokenType: "Bearer" as const,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
        meta: { requestId: request.requestId },
      });
    },
  );
};

export default authRoutes;
