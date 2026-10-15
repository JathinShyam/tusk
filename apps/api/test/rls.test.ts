import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres, { type TransactionSql } from "postgres";
import {
  buildTestApp,
  randomSuffix,
  TEST_DATABASE_URL,
  uniqueEmail,
} from "./helpers.js";

const PASSWORD = "correct-horse-battery-staple";

type Seed = {
  email: string;
  userId: string;
  tenantId: string;
  accessToken: string;
};

async function seedTenantUser(
  app: FastifyInstance,
  prefix: string,
): Promise<Seed> {
  const email = uniqueEmail(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email,
      password: PASSWORD,
      tenant: { name: `RLS ${prefix} ${randomSuffix()}` },
    },
  });
  expect(res.statusCode).toBe(201);
  const data = res.json().data;
  return {
    email,
    userId: data.user.id,
    tenantId: data.tenant.id,
    accessToken: data.accessToken,
  };
}

describe("RLS isolation (TR-SEC-003, FR-ID-011/012)", () => {
  let app: FastifyInstance;
  const appSql = postgres(TEST_DATABASE_URL, { max: 4 });

  let tenantA: Seed;
  let tenantB: Seed;

  beforeAll(async () => {
    app = await buildTestApp();
    tenantA = await seedTenantUser(app, "alice");
    tenantB = await seedTenantUser(app, "bob");
  });

  afterAll(async () => {
    await app.close();
    await appSql.end({ timeout: 5 });
  });

  /** Run as tusk_app with the same SET LOCAL contract the API uses. */
  async function withContext<T>(
    ctx: { tenantId?: string; userId?: string; role?: string },
    fn: (tx: TransactionSql) => Promise<T>,
  ): Promise<T> {
    const result = await appSql.begin(async (tx) => {
      if (ctx.tenantId) {
        await tx`select set_config('app.tenant_id', ${ctx.tenantId}, true)`;
      }
      if (ctx.userId) {
        await tx`select set_config('app.user_id', ${ctx.userId}, true)`;
      }
      if (ctx.role) {
        await tx`select set_config('app.role', ${ctx.role}, true)`;
      }
      return fn(tx);
    });
    return result as T;
  }

  it("app role has no BYPASSRLS and tenant tables FORCE RLS", async () => {
    const roles = await appSql<{ rolbypassrls: boolean }[]>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(roles[0]!.rolbypassrls).toBe(false);

    const tables = await appSql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('tenants', 'memberships')
    `;
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }
  });

  it("queries without SET LOCAL return zero rows (FR-ID-011)", async () => {
    const tenants = await appSql.begin(
      async (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM tenants`,
    );
    const memberships = await appSql.begin(
      async (tx) =>
        tx<{ count: number }[]>`SELECT count(*)::int AS count FROM memberships`,
    );
    expect(tenants[0]!.count).toBe(0);
    expect(memberships[0]!.count).toBe(0);
  });

  it("reverted SET LOCAL leaves no session residue on a pooled connection", async () => {
    // max: 1 forces the same backend connection across both transactions.
    const pooled = postgres(TEST_DATABASE_URL, { max: 1 });
    try {
      const inside = await pooled.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA.tenantId}, true)`;
        await tx`select set_config('app.user_id', ${tenantA.userId}, true)`;
        await tx`select set_config('app.role', 'tenant_admin', true)`;
        return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM tenants`;
      });
      expect(inside[0]!.count).toBe(1);

      const after = await pooled.begin(
        async (tx) =>
          tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM tenants
          `,
      );
      expect(after[0]!.count).toBe(0);
    } finally {
      await pooled.end({ timeout: 5 });
    }
  });

  it("tenant B cannot read tenant A rows with a stolen UUID", async () => {
    const result = await withContext(
      {
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        role: "tenant_admin",
      },
      async (tx) => {
        const stolenTenant = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM tenants WHERE id = ${tenantA.tenantId}
        `;
        const stolenMemberships = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM memberships WHERE tenant_id = ${tenantA.tenantId}
        `;
        const ownTenants = await tx<{ id: string }[]>`SELECT id FROM tenants`;
        const ownMemberships = await tx<{ tenant_id: string }[]>`
          SELECT tenant_id FROM memberships
        `;
        return { stolenTenant, stolenMemberships, ownTenants, ownMemberships };
      },
    );

    expect(result.stolenTenant[0]!.count).toBe(0);
    expect(result.stolenMemberships[0]!.count).toBe(0);
    expect(result.ownTenants.map((t) => t.id)).toEqual([tenantB.tenantId]);
    expect(result.ownMemberships.map((m) => m.tenant_id)).toEqual([
      tenantB.tenantId,
    ]);
  });

  it("tenant B cannot insert a membership into tenant A", async () => {
    await expect(
      withContext(
        {
          tenantId: tenantB.tenantId,
          userId: tenantB.userId,
          role: "tenant_admin",
        },
        async (tx) => {
          await tx`
            INSERT INTO memberships (tenant_id, user_id, role)
            VALUES (${tenantA.tenantId}, ${tenantB.userId}, 'explorer')
          `;
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("tenant B cannot update tenant A", async () => {
    const updated = await withContext(
      {
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        role: "tenant_admin",
      },
      async (tx) => {
        const result = await tx`
          UPDATE tenants SET name = 'hacked' WHERE id = ${tenantA.tenantId}
        `;
        return result.count;
      },
    );
    expect(updated).toBe(0);

    const rows = await withContext(
      {
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        role: "tenant_admin",
      },
      async (tx) =>
        tx<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${tenantA.tenantId}`,
    );
    expect(rows[0]!.name).not.toBe("hacked");
  });

  it("API: /v1/me only lists the caller's memberships", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.memberships).toHaveLength(1);
    expect(data.memberships[0].tenantId).toBe(tenantB.tenantId);
    expect(data.activeTenant.tenantId).toBe(tenantB.tenantId);
    expect(JSON.stringify(data)).not.toContain(tenantA.tenantId);
  });

  it("API: B cannot switch into tenant A (no existence leak)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/switch-tenant",
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { tenantId: tenantA.tenantId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NO_MEMBERSHIP");
  });
});
