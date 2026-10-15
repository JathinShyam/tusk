import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../lib/errors.js";
import {
  PLATFORM_ROLE,
  verifyAccessToken,
  type AccessClaims,
} from "../../modules/identity/tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AccessClaims | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => Promise<void>;
    requireTenantAuth: (request: FastifyRequest) => Promise<void>;
    requirePlatformAuth: (request: FastifyRequest) => Promise<void>;
  }
}

export function authOf(request: FastifyRequest): AccessClaims {
  if (!request.auth) {
    throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
  }
  return request.auth;
}

export function activeTenantId(request: FastifyRequest): string {
  const auth = authOf(request);
  if (!auth.tenantId) {
    throw new AppError(
      "NO_MEMBERSHIP",
      403,
      "No active tenant on this token; call POST /v1/auth/switch-tenant",
    );
  }
  return auth.tenantId;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const authPlugin: FastifyPluginAsync<{ config: AppConfig }> = async (
  app,
  opts,
) => {
  app.decorateRequest("auth", null);

  app.decorate("requireAuth", async (request: FastifyRequest) => {
    if (request.auth) return;
    const token = extractBearer(request.headers.authorization);
    if (!token) {
      throw new AppError("UNAUTHENTICATED", 401, "Missing bearer token");
    }
    try {
      request.auth = await verifyAccessToken(opts.config, token);
    } catch (error) {
      request.log.debug({ err: error }, "access token rejected");
      throw new AppError(
        "UNAUTHENTICATED",
        401,
        "Invalid or expired access token",
      );
    }
  });

  app.decorate("requireTenantAuth", async (request: FastifyRequest) => {
    await app.requireAuth(request);
    if (!request.auth?.tenantId) {
      throw new AppError(
        "NO_MEMBERSHIP",
        403,
        "No active tenant on this token; call POST /v1/auth/switch-tenant",
      );
    }
  });

  app.decorate("requirePlatformAuth", async (request: FastifyRequest) => {
    await app.requireAuth(request);
    if (request.auth?.role !== PLATFORM_ROLE) {
      throw new AppError("FORBIDDEN", 403, "Platform admin access required");
    }
  });
};

export default fp(authPlugin, { name: "auth" });
