# PRD — Identity, tenancy, authentication

**ID prefix:** `FR-ID-*`  
**Phase:** 1 (bootstrap in 0 for health only)  
**Master:** [PRD.md](../PRD.md)

## 1. Problem

Tusk is multi-tenant SaaS. Without a real membership model and RLS, every later feature leaks data.

## 2. In scope

Users, tenants, memberships, roles, register/login/refresh/logout, platform tenant provisioning, tenant settings patch.

## 3. Out of scope

OAuth/social login, magic links, SSO/SAML, MFA, SCIM. Password + JWT only.

## 4. Roles

| Role | Scope |
|------|--------|
| `explorer` | Default member |
| `host` | Can create places/experiences they own |
| `tenant_admin` | Tenant settings, moderate, impersonate host powers |
| `platform_admin` | Create tenants; no automatic access to tenant **data** unless also a member — **decision:** platform_admin JWT without `tid` uses platform routes only; to read tenant data they must assume a membership. |

A user has one role **per tenant** (`memberships.role`). JWT `role` is the role for the active `tid`.

## 5. Functional requirements

| ID | Requirement | Acceptance |
|----|-------------|------------|
| FR-ID-001 | Email + password register creates a `users` row; password stored Argon2id | DB has hash; login works |
| FR-ID-002 | Email unique globally on `users` | Second register with same email → `409 EMAIL_TAKEN` |
| FR-ID-003 | Login returns access JWT + refresh token (body or httpOnly cookie — **decision: JSON body** for API-first) | Refresh works |
| FR-ID-004 | Self-serve tenant: if `ALLOW_SELF_TENANT=true`, register may create tenant + `tenant_admin` membership; else register-only user cannot call tenant APIs until invited | Documented in README |
| FR-ID-005 | Platform admin `POST /v1/platform/tenants` creates tenant | Authz: `platform_admin` |
| FR-ID-006 | Invite: tenant_admin `POST /v1/admin/memberships` { email, role } creates or attaches user | If user missing, create **invite-pending** or require they register first — **decision: user must exist; 404 USER_NOT_FOUND** for v1 |
| FR-ID-007 | Active tenant in JWT; header `X-Tenant-Id` **not** used (prevents tampering) | Switching tenant: `POST /v1/auth/switch-tenant` { tenantId } issues new JWT if membership exists |
| FR-ID-008 | `GET /v1/me` returns user + memberships + active tenant | |
| FR-ID-009 | Logout revokes refresh token | Reuse refresh → 401 |
| FR-ID-010 | Refresh rotation: old token invalid; reuse of rotated token revokes family | Test reuse detection |
| FR-ID-011 | RLS uses `app.tenant_id` / `app.user_id` / `app.role` | Missing settings → empty select |
| FR-ID-012 | `FORCE ROW LEVEL SECURITY` on all tenant tables | Superuser tests don’t count as app |
| FR-ID-013 | Tenant `settings jsonb` patch by tenant_admin only | Ranking weights later live here |
| FR-ID-014 | Tenant `slug` unique, `[a-z0-9-]+` | Validation 400 |
| FR-ID-015 | Soft-disable: `tenants.status = suspended` → API 403 `TENANT_SUSPENDED` | |

## 6. User stories

- As an explorer, I register and log in so I can book later.
- As a tenant admin, I add an existing user as host.
- As platform admin, I provision a city tenant without seeing their places until I am a member.

## 7. Error codes

`EMAIL_TAKEN`, `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `FORBIDDEN`, `TENANT_SUSPENDED`, `USER_NOT_FOUND`, `NO_MEMBERSHIP`.

## 8. Data

See TRD §7: `tenants`, `users`, `memberships`, `refresh_tokens`.

Memberships RLS: user can read own memberships; tenant_admin can read all memberships in tenant.

## 9. Metrics / tests

TR-TEST-002, TR-TEST-003 (once a tenant-scoped entity exists). Isolation test in Phase 1 may use `memberships` + a `rls_probe` table dropped after places exist.

## 10. Dependencies

Phase 0 pool + migrate. No geo.
