import { createHmac, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "../../config.js";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** Roles a membership can carry (PRD §4). platform_admin is a user flag, not a membership role. */
export const MEMBER_ROLES = ["explorer", "host", "tenant_admin"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const PLATFORM_ROLE = "platform_admin";
export type Role = MemberRole | typeof PLATFORM_ROLE;

export type AccessClaims = {
  userId: string;
  tenantId: string | null;
  role: Role | null;
};

function isMemberRole(value: string): value is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(value);
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
  return value;
}

function accessSecret(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.jwtAccessSecret);
}

export async function signAccessToken(
  config: AppConfig,
  claims: AccessClaims,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tid: claims.tenantId, role: claims.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(accessSecret(config));
}

/**
 * Throws on any malformed claim so callers translate to 401 UNAUTHENTICATED.
 * tid implies a member role; only tenant-less tokens may carry platform_admin.
 */
export async function verifyAccessToken(
  config: AppConfig,
  token: string,
): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessSecret(config), {
    algorithms: ["HS256"],
  });

  const userId = payload.sub;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("invalid sub");
  }

  const tenantId = asNullableString(payload.tid, "tid");
  const role = asNullableString(payload.role, "role");

  if (tenantId !== null && (role === null || !isMemberRole(role))) {
    throw new Error("tenant token requires a member role");
  }
  if (tenantId === null && role !== null && role !== PLATFORM_ROLE) {
    throw new Error("tenant-less token cannot carry a member role");
  }

  // Checks above guarantee: member role with tid, platform_admin/null without.
  return { userId, tenantId, role: role as Role | null };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Refresh tokens are opaque; only an HMAC of the raw token is stored
 * (TR-SEC-002), keyed by JWT_REFRESH_SECRET so a DB dump alone is not enough
 * to forge a stored hash.
 */
export function hashRefreshToken(config: AppConfig, token: string): string {
  return createHmac("sha256", config.jwtRefreshSecret)
    .update(token)
    .digest("hex");
}
