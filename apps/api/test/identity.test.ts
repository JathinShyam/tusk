import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import {
  buildTestApp,
  randomSuffix,
  TEST_MIGRATE_URL,
  testConfig,
  uniqueEmail,
} from "./helpers.js";
import { hashRefreshToken } from "../src/modules/identity/tokens.js";

const PASSWORD = "correct-horse-battery-staple";

type Json = Record<string, any>;

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function post(
  app: FastifyInstance,
  url: string,
  payload: Json,
  token?: string,
) {
  const res = await app.inject({
    method: "POST",
    url,
    payload,
    headers: token ? bearer(token) : {},
  });
  return { status: res.statusCode, body: res.json() as Json };
}

async function get(app: FastifyInstance, url: string, token?: string) {
  const res = await app.inject({
    method: "GET",
    url,
    headers: token ? bearer(token) : {},
  });
  return { status: res.statusCode, body: res.json() as Json };
}

describe("identity & tenancy (Phase 1)", () => {
  let app: FastifyInstance;
  const migrator = postgres(TEST_MIGRATE_URL, { max: 2 });

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await migrator.end({ timeout: 5 });
  });

  describe("register → login → me (TR-TEST-002)", () => {
    it("register with self-tenant returns user, tenant and tokens", async () => {
      const email = uniqueEmail("owner");
      const out = await post(app, "/v1/auth/register", {
        email,
        password: PASSWORD,
        tenant: { name: `Harbor City ${randomSuffix()}` },
      });

      expect(out.status).toBe(201);
      expect(out.body.data.user.email).toBe(email);
      expect(out.body.data.user.isPlatformAdmin).toBe(false);
      expect(out.body.data.tenant.slug).toMatch(/^harbor-city-[0-9a-f]{8}$/);
      expect(out.body.data.tenant.status).toBe("active");
      expect(out.body.data.accessToken).toBeTruthy();
      expect(out.body.data.refreshToken).toBeTruthy();
      expect(out.body.data.expiresIn).toBe(900);
      const serialized = JSON.stringify(out.body);
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("argon2");
    });

    it("GET /v1/me returns user, memberships and active tenant", async () => {
      const email = uniqueEmail("me");
      const reg = await post(app, "/v1/auth/register", {
        email,
        password: PASSWORD,
        tenant: { name: `Me City ${randomSuffix()}` },
      });
      const token = reg.body.data.accessToken as string;
      const tenantId = reg.body.data.tenant.id as string;

      const me = await get(app, "/v1/me", token);
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe(email);
      expect(me.body.data.memberships).toHaveLength(1);
      expect(me.body.data.memberships[0].role).toBe("tenant_admin");
      expect(me.body.data.activeTenant.tenantId).toBe(tenantId);
    });

    it("GET /v1/me without a token is 401 UNAUTHENTICATED", async () => {
      const me = await get(app, "/v1/me");
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("login returns tokens and rejects a wrong password", async () => {
      const email = uniqueEmail("login");
      await post(app, "/v1/auth/register", {
        email,
        password: PASSWORD,
        tenant: { name: `Login City ${randomSuffix()}` },
      });

      const ok = await post(app, "/v1/auth/login", { email, password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(ok.body.data.accessToken).toBeTruthy();
      expect(ok.body.data.activeTenantId).toBeTruthy();

      const bad = await post(app, "/v1/auth/login", {
        email,
        password: "wrong-password-123",
      });
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("rejects whitespace-only tenant names with 400", async () => {
      const out = await post(app, "/v1/auth/register", {
        email: uniqueEmail("blank"),
        password: PASSWORD,
        tenant: { name: "   " },
      });
      expect(out.status).toBe(400);
      expect(out.body.error.code).toBe("VALIDATION");

      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("blankpatch"),
        password: PASSWORD,
        tenant: { name: `Blank Patch ${randomSuffix()}` },
      });
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tenant",
        headers: bearer(reg.body.data.accessToken as string),
        payload: { name: "  " },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    });

    it("duplicate email is 409 EMAIL_TAKEN (FR-ID-002)", async () => {
      const email = uniqueEmail("dup");
      await post(app, "/v1/auth/register", { email, password: PASSWORD });
      const second = await post(app, "/v1/auth/register", {
        email,
        password: PASSWORD,
      });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("EMAIL_TAKEN");
    });

    it("register without a tenant yields a tenant-less session (FR-ID-004)", async () => {
      const email = uniqueEmail("tenantless");
      const reg = await post(app, "/v1/auth/register", {
        email,
        password: PASSWORD,
      });
      expect(reg.status).toBe(201);
      expect(reg.body.data.tenant).toBeNull();

      const me = await get(app, "/v1/me", reg.body.data.accessToken as string);
      expect(me.status).toBe(200);
      expect(me.body.data.memberships).toHaveLength(0);
      expect(me.body.data.activeTenant).toBeNull();

      const admin = await get(
        app,
        "/v1/admin/tenant",
        reg.body.data.accessToken as string,
      );
      expect(admin.status).toBe(403);
      expect(admin.body.error.code).toBe("NO_MEMBERSHIP");
    });

    it("switch-tenant without membership is 403 NO_MEMBERSHIP (FR-ID-007)", async () => {
      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("switcher"),
        password: PASSWORD,
        tenant: { name: `Switch City ${randomSuffix()}` },
      });
      const token = reg.body.data.accessToken as string;
      const randomTenantId = randomUUID();

      const out = await post(
        app,
        "/v1/auth/switch-tenant",
        { tenantId: randomTenantId },
        token,
      );
      expect(out.status).toBe(403);
      expect(out.body.error.code).toBe("NO_MEMBERSHIP");
    });
  });

  describe("refresh rotation and logout (FR-ID-009, FR-ID-010)", () => {
    it("rotates refresh tokens and revokes the family on reuse", async () => {
      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("rotate"),
        password: PASSWORD,
        tenant: { name: `Rotate City ${randomSuffix()}` },
      });
      const first = reg.body.data.refreshToken as string;

      const rotated = await post(app, "/v1/auth/refresh", {
        refreshToken: first,
      });
      expect(rotated.status).toBe(200);
      const second = rotated.body.data.refreshToken as string;
      expect(second).not.toBe(first);

      const me = await get(app, "/v1/me", rotated.body.data.accessToken as string);
      expect(me.status).toBe(200);

      // Reusing the rotated token is detected and kills the whole family.
      const reuse = await post(app, "/v1/auth/refresh", {
        refreshToken: first,
      });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe("UNAUTHENTICATED");

      const after = await post(app, "/v1/auth/refresh", {
        refreshToken: second,
      });
      expect(after.status).toBe(401);
    });

    it("rejects an expired refresh token", async () => {
      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("expired"),
        password: PASSWORD,
      });
      const refreshToken = reg.body.data.refreshToken as string;
      const tokenHash = hashRefreshToken(testConfig(), refreshToken);

      await migrator`
        UPDATE refresh_tokens SET expires_at = now() - interval '1 second'
        WHERE token_hash = ${tokenHash}
      `;

      const out = await post(app, "/v1/auth/refresh", { refreshToken });
      expect(out.status).toBe(401);
      expect(out.body.error.code).toBe("UNAUTHENTICATED");
      expect(out.body.error.message).toBe("Refresh token expired");
    });

    it("logout revokes the refresh token", async () => {
      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("logout"),
        password: PASSWORD,
      });
      const refreshToken = reg.body.data.refreshToken as string;

      const out = await post(app, "/v1/auth/logout", { refreshToken });
      expect(out.status).toBe(200);

      const reuse = await post(app, "/v1/auth/refresh", { refreshToken });
      expect(reuse.status).toBe(401);
    });
  });

  describe("platform provisioning and invites (FR-ID-005, FR-ID-006)", () => {
    let adminToken = "";
    let tenantAdminToken = "";
    let tenantId = "";
    let inviteeEmail = "";
    let inviteeToken = "";

    it("platform admin creates a tenant and administers it as tenant_admin", async () => {
      const adminEmail = uniqueEmail("platform");
      await post(app, "/v1/auth/register", {
        email: adminEmail,
        password: PASSWORD,
      });
      // Bootstrap per README: the first platform admin is flagged via SQL.
      await migrator`
        UPDATE users SET is_platform_admin = true
        WHERE lower(email) = ${adminEmail}
      `;

      const login = await post(app, "/v1/auth/login", {
        email: adminEmail,
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      expect(login.body.data.activeTenantId).toBeNull();
      adminToken = login.body.data.accessToken as string;

      const created = await post(
        app,
        "/v1/platform/tenants",
        { name: `Provisioned ${randomSuffix()}`, type: "city" },
        adminToken,
      );
      expect(created.status).toBe(201);
      expect(created.body.data.tenant.slug).toMatch(/^provisioned-[0-9a-f]{8}$/);
      tenantId = created.body.data.tenant.id as string;

      const switched = await post(
        app,
        "/v1/auth/switch-tenant",
        { tenantId },
        adminToken,
      );
      expect(switched.status).toBe(200);
      tenantAdminToken = switched.body.data.accessToken as string;

      const adminTenant = await get(app, "/v1/admin/tenant", tenantAdminToken);
      expect(adminTenant.status).toBe(200);
      expect(adminTenant.body.data.tenant.id).toBe(tenantId);
    });

    it("a non-platform user cannot create tenants", async () => {
      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("notplatform"),
        password: PASSWORD,
        tenant: { name: `Regular ${randomSuffix()}` },
      });
      const out = await post(
        app,
        "/v1/platform/tenants",
        { name: "Should Not Exist" },
        reg.body.data.accessToken as string,
      );
      expect(out.status).toBe(403);
      expect(out.body.error.code).toBe("FORBIDDEN");
    });

    it("tenant admin invites an existing user; explorer cannot use admin routes", async () => {
      inviteeEmail = uniqueEmail("invitee");
      const reg = await post(app, "/v1/auth/register", {
        email: inviteeEmail,
        password: PASSWORD,
      });
      expect(reg.status).toBe(201);

      const invite = await post(
        app,
        "/v1/admin/memberships",
        { email: inviteeEmail, role: "explorer" },
        tenantAdminToken,
      );
      expect(invite.status).toBe(201);
      expect(invite.body.data.membership.role).toBe("explorer");
      expect(invite.body.data.membership.tenantId).toBe(tenantId);

      // The invitee now has exactly one membership: login auto-activates it.
      const login = await post(app, "/v1/auth/login", {
        email: inviteeEmail,
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      expect(login.body.data.activeTenantId).toBe(tenantId);
      inviteeToken = login.body.data.accessToken as string;

      const forbiddenGet = await get(app, "/v1/admin/tenant", inviteeToken);
      expect(forbiddenGet.status).toBe(403);
      expect(forbiddenGet.body.error.code).toBe("FORBIDDEN");

      const res = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tenant",
        headers: bearer(inviteeToken),
        payload: { name: "Explorer Override" },
      });
      expect(res.statusCode).toBe(403);

      const me = await get(app, "/v1/me", inviteeToken);
      expect(me.body.data.activeTenant.role).toBe("explorer");
      expect(me.body.data.memberships).toHaveLength(1);
    });

    it("inviting an unknown user is 404 USER_NOT_FOUND", async () => {
      const out = await post(
        app,
        "/v1/admin/memberships",
        { email: uniqueEmail("ghost"), role: "host" },
        tenantAdminToken,
      );
      expect(out.status).toBe(404);
      expect(out.body.error.code).toBe("USER_NOT_FOUND");
    });

    it("inviting the same user twice is 409 MEMBERSHIP_EXISTS", async () => {
      const out = await post(
        app,
        "/v1/admin/memberships",
        { email: inviteeEmail, role: "host" },
        tenantAdminToken,
      );
      expect(out.status).toBe(409);
      expect(out.body.error.code).toBe("MEMBERSHIP_EXISTS");
    });
  });

  describe("tenant settings patch (FR-ID-013, FR-ID-014)", () => {
    it("patches name and shallow-merges settings; rejects empty patches", async () => {
      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("settings"),
        password: PASSWORD,
        tenant: { name: `Settings City ${randomSuffix()}` },
      });
      const token = reg.body.data.accessToken as string;

      const first = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tenant",
        headers: bearer(token),
        payload: {
          name: "Settings City Renamed",
          settings: { ranking: { text: 0.5, geo: 0.2 } },
        },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().data.tenant.name).toBe("Settings City Renamed");
      expect(first.json().data.tenant.settings.ranking.text).toBe(0.5);

      const second = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tenant",
        headers: bearer(token),
        payload: { settings: { locale: "en" } },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.tenant.settings).toEqual({
        ranking: { text: 0.5, geo: 0.2 },
        locale: "en",
      });

      const empty = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tenant",
        headers: bearer(token),
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.code).toBe("VALIDATION");
    });

    it("rejects invalid slugs and suspended tenants (FR-ID-014, FR-ID-015)", async () => {
      const invalid = await post(app, "/v1/auth/register", {
        email: uniqueEmail("slug"),
        password: PASSWORD,
        tenant: { name: "Slug City", slug: "Not Valid!" },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("VALIDATION");

      const reg = await post(app, "/v1/auth/register", {
        email: uniqueEmail("suspended"),
        password: PASSWORD,
        tenant: { name: `Suspend City ${randomSuffix()}` },
      });
      const tenantId = reg.body.data.tenant.id as string;
      const token = reg.body.data.accessToken as string;

      await migrator`
        UPDATE tenants SET status = 'suspended' WHERE id = ${tenantId}
      `;

      const login = await post(app, "/v1/auth/login", {
        email: reg.body.data.user.email as string,
        password: PASSWORD,
      });
      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe("TENANT_SUSPENDED");

      const patch = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tenant",
        headers: bearer(token),
        payload: { name: "Should Fail" },
      });
      expect(patch.statusCode).toBe(403);
      expect(patch.json().error.code).toBe("TENANT_SUSPENDED");

      const read = await get(app, "/v1/admin/tenant", token);
      expect(read.status).toBe(403);
      expect(read.body.error.code).toBe("TENANT_SUSPENDED");
    });
  });

  describe("auth rate limiting", () => {
    it("rate limits repeated failed logins with 429 RATE_LIMITED", async () => {
      const email = uniqueEmail("bruteforce");
      await post(app, "/v1/auth/register", { email, password: PASSWORD });

      let last: { status: number; body: Json } = { status: 0, body: {} };
      for (let i = 0; i < 11; i += 1) {
        last = await post(app, "/v1/auth/login", {
          email,
          password: "wrong-password-123",
        });
      }
      expect(last.status).toBe(429);
      expect(last.body.error.code).toBe("RATE_LIMITED");
    });
  });

  describe("self-serve gating (FR-ID-004)", () => {
    it("ALLOW_SELF_TENANT=false rejects tenant bootstrap but allows plain register", async () => {
      const closed = await buildTestApp({ allowSelfTenant: false });
      try {
        const denied = await post(closed, "/v1/auth/register", {
          email: uniqueEmail("closed"),
          password: PASSWORD,
          tenant: { name: "Not Allowed" },
        });
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe("FORBIDDEN");

        const plain = await post(closed, "/v1/auth/register", {
          email: uniqueEmail("closed-plain"),
          password: PASSWORD,
        });
        expect(plain.status).toBe(201);
        expect(plain.body.data.tenant).toBeNull();
      } finally {
        await closed.close();
      }
    });
  });
});
