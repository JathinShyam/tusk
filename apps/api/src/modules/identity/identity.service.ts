import type { ISql, JSONValue, TransactionSql } from "postgres";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../lib/errors.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  PLATFORM_ROLE,
  REFRESH_TOKEN_TTL_DAYS,
  type MemberRole,
  type Role,
} from "./tokens.js";

export type UserRow = {
  id: string;
  email: string;
  is_platform_admin: boolean;
  created_at: Date;
};

export type UserWithPasswordRow = UserRow & { password_hash: string };

export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type MembershipRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  role: MemberRole;
  created_at: Date;
};

export type MembershipWithTenantRow = {
  tenant_id: string;
  role: MemberRole;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
};

export type RefreshTokenRow = {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
};


function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; constraint_name?: unknown };
  return e.code === "23505" && e.constraint_name === constraint;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "tenant";
}

export async function reserveId(tx: TransactionSql): Promise<string> {
  const rows = await tx<{ id: string }[]>`SELECT uuidv7() AS id`;
  return rows[0]!.id;
}

export async function findUserByEmail(
  tx: ISql,
  email: string,
): Promise<UserWithPasswordRow | null> {
  const rows = await tx<UserWithPasswordRow[]>`
    SELECT id, email, is_platform_admin, created_at, password_hash
    FROM users
    WHERE lower(email) = lower(${email})
  `;
  return rows[0] ?? null;
}

export async function findUserById(
  tx: TransactionSql,
  userId: string,
): Promise<UserRow | null> {
  const rows = await tx<UserRow[]>`
    SELECT id, email, is_platform_admin, created_at FROM users WHERE id = ${userId}
  `;
  return rows[0] ?? null;
}

export async function createUser(
  tx: TransactionSql,
  email: string,
  passwordHash: string,
): Promise<UserRow> {
  try {
    const rows = await tx<UserRow[]>`
      INSERT INTO users (email, password_hash)
      VALUES (${email}, ${passwordHash})
      RETURNING id, email, is_platform_admin, created_at
    `;
    return rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) {
      throw new AppError(
        "EMAIL_TAKEN",
        409,
        "An account with this email already exists",
      );
    }
    throw error;
  }
}

/**
 * Tenant provisioning bootstrap (self-serve register or platform create).
 * Reserves the id first, pins `app.tenant_id` to it, then inserts: the
 * `tenants_select` policy uses `id = app.tenant_id`, and `INSERT ... RETURNING`
 * requires SELECT visibility of the new row.
 */
export async function provisionTenant(
  tx: TransactionSql,
  input: { name: string; slug: string; type?: string | undefined },
): Promise<TenantRow> {
  const id = await reserveId(tx);
  await tx`select set_config('app.tenant_id', ${id}, true)`;
  try {
    const rows = await tx<TenantRow[]>`
      INSERT INTO tenants (id, name, slug, type)
      VALUES (${id}, ${input.name}, ${input.slug}, ${input.type ?? "city"})
      RETURNING id, name, slug, type, status, settings, created_at, updated_at
    `;
    return rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, "tenants_slug_unique")) {
      throw new AppError(
        "TENANT_SLUG_TAKEN",
        409,
        "This tenant slug is already in use",
      );
    }
    throw error;
  }
}

export async function getTenant(
  tx: TransactionSql,
  tenantId: string,
): Promise<TenantRow | null> {
  const rows = await tx<TenantRow[]>`
    SELECT id, name, slug, type, status, settings, created_at, updated_at
    FROM tenants WHERE id = ${tenantId}
  `;
  return rows[0] ?? null;
}

export async function updateTenant(
  tx: TransactionSql,
  tenantId: string,
  patch: {
    name?: string | undefined;
    settings?: Record<string, unknown> | undefined;
  },
): Promise<TenantRow | null> {
  const rows = await tx<TenantRow[]>`
    UPDATE tenants
    SET name = coalesce(${patch.name ?? null}, name),
        settings = coalesce(
          settings || ${patch.settings === undefined ? null : tx.json(patch.settings as JSONValue)}::jsonb,
          settings
        )
    WHERE id = ${tenantId}
    RETURNING id, name, slug, type, status, settings, created_at, updated_at
  `;
  return rows[0] ?? null;
}

export async function addMembership(
  tx: TransactionSql,
  input: { tenantId: string; userId: string; role: MemberRole },
): Promise<MembershipRow> {
  try {
    const rows = await tx<MembershipRow[]>`
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES (${input.tenantId}, ${input.userId}, ${input.role})
      RETURNING id, tenant_id, user_id, role, created_at
    `;
    return rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, "memberships_tenant_user_unique")) {
      throw new AppError(
        "MEMBERSHIP_EXISTS",
        409,
        "User is already a member of this tenant",
      );
    }
    throw error;
  }
}

export async function findMembership(
  tx: TransactionSql,
  tenantId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const rows = await tx<MembershipRow[]>`
    SELECT id, tenant_id, user_id, role, created_at
    FROM memberships
    WHERE tenant_id = ${tenantId} AND user_id = ${userId}
  `;
  return rows[0] ?? null;
}

export async function listMembershipsWithTenant(
  tx: TransactionSql,
  userId: string,
): Promise<MembershipWithTenantRow[]> {
  return tx<MembershipWithTenantRow[]>`
    SELECT m.tenant_id, m.role,
           t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = ${userId}
    ORDER BY m.created_at ASC, m.tenant_id ASC
  `;
}

export async function assertTenantAdmin(
  tx: TransactionSql,
  tenantId: string,
  userId: string,
): Promise<void> {
  const membership = await findMembership(tx, tenantId, userId);
  if (!membership || membership.role !== "tenant_admin") {
    throw new AppError("FORBIDDEN", 403, "Tenant admin access required");
  }
}

export async function issueRefreshToken(
  tx: TransactionSql,
  config: AppConfig,
  input: { userId: string; familyId?: string | null },
): Promise<{ id: string; token: string }> {
  const token = generateRefreshToken();
  const tokenHash = hashRefreshToken(config, token);
  const rows = input.familyId
    ? await tx<{ id: string }[]>`
        INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
        VALUES (${input.userId}, ${input.familyId}, ${tokenHash},
                now() + make_interval(days => ${REFRESH_TOKEN_TTL_DAYS}))
        RETURNING id
      `
    : await tx<{ id: string }[]>`
        INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
        VALUES (${input.userId}, ${tokenHash},
                now() + make_interval(days => ${REFRESH_TOKEN_TTL_DAYS}))
        RETURNING id
      `;
  return { id: rows[0]!.id, token };
}

export type SessionContext = {
  tenantId: string | null;
  role: Role | null;
  memberships: MembershipWithTenantRow[];
};

/**
 * Deterministic session context (login + refresh):
 * - platform admins get a tenant-less platform token (PRD §4),
 * - a user with exactly one membership lands directly in that tenant,
 * - anything else stays tenant-less until POST /v1/auth/switch-tenant.
 * Requires `app.user_id` to already be set in the transaction.
 */
export async function resolveSessionContext(
  tx: TransactionSql,
  user: Pick<UserRow, "id" | "is_platform_admin">,
): Promise<SessionContext> {
  if (user.is_platform_admin) {
    return {
      tenantId: null,
      role: PLATFORM_ROLE,
      memberships: await listMembershipsWithTenant(tx, user.id),
    };
  }

  const memberships = await listMembershipsWithTenant(tx, user.id);
  if (memberships.length === 1) {
    const only = memberships[0]!;
    if (only.tenant_status === "suspended") {
      throw new AppError("TENANT_SUSPENDED", 403, "Tenant is suspended");
    }
    return { tenantId: only.tenant_id, role: only.role, memberships };
  }

  return { tenantId: null, role: null, memberships };
}

export function toUserDto(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    isPlatformAdmin: row.is_platform_admin,
    createdAt: row.created_at.toISOString(),
  };
}

export function toTenantDto(row: TenantRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    settings: row.settings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toMembershipDto(row: MembershipWithTenantRow) {
  return {
    tenantId: row.tenant_id,
    role: row.role,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    tenantStatus: row.tenant_status,
  };
}
