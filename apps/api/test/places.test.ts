import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres, { type TransactionSql } from "postgres";
import {
  buildTestApp,
  registerTenantUser,
  TEST_DATABASE_URL,
  TEST_MIGRATE_URL,
  type TenantUserSeed,
} from "./helpers.js";

const LONDON = { lat: 51.5072, lng: -0.1276 };
// 0.001° of longitude ≈ 69.3 m at this latitude; 0.02° ≈ 1386 m.

type ApiPlace = {
  id: string;
  tenantId: string;
  hostUserId: string;
  title: string;
  status: string;
  lat: number;
  lng: number;
  distanceM?: number;
  attrs: Record<string, unknown>;
  createdAt: string;
};

describe("places & geospatial (FR-GEO-*, Phase 2)", () => {
  let app: FastifyInstance;
  const appSql = postgres(TEST_DATABASE_URL, { max: 4 });

  let adminA: TenantUserSeed;
  let adminB: TenantUserSeed;

  beforeAll(async () => {
    app = await buildTestApp();
    adminA = await registerTenantUser(app, "places-a");
    adminB = await registerTenantUser(app, "places-b");
  });

  afterAll(async () => {
    await app.close();
    await appSql.end({ timeout: 5 });
  });

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function postPlace(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/places",
      headers: authed(token),
      payload,
    });
  }

  async function createPlace(
    token: string,
    overrides: Partial<{ lng: number; lat: number; status: string; title: string }> = {},
  ): Promise<ApiPlace> {
    const res = await postPlace(token, {
      title: overrides.title ?? `Place ${Math.random().toString(36).slice(2, 8)}`,
      lng: overrides.lng ?? LONDON.lng,
      lat: overrides.lat ?? LONDON.lat,
      status: overrides.status ?? "published",
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.place as ApiPlace;
  }

  async function getPlace(token: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/v1/places/${id}`,
      headers: authed(token),
    });
  }

  async function listPlaces(token: string, qs = "") {
    return app.inject({
      method: "GET",
      url: `/v1/places${qs}`,
      headers: authed(token),
    });
  }

  /** Register a user, invite them into `tenant` with `role`, scope a token to it. */
  async function makeMember(
    tenant: TenantUserSeed,
    role: "host" | "explorer",
  ): Promise<TenantUserSeed> {
    const user = await registerTenantUser(app, role);
    const invite = await app.inject({
      method: "POST",
      url: "/v1/admin/memberships",
      headers: authed(tenant.accessToken),
      payload: { email: user.email, role },
    });
    expect(invite.statusCode).toBe(201);
    const switched = await app.inject({
      method: "POST",
      url: "/v1/auth/switch-tenant",
      headers: authed(user.accessToken),
      payload: { tenantId: tenant.tenantId },
    });
    expect(switched.statusCode).toBe(200);
    return {
      ...user,
      tenantId: tenant.tenantId,
      accessToken: switched.json().data.accessToken,
    };
  }

  /** Same SET LOCAL contract as the API (see withRls). */
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

  it("FR-GEO-001/002: creates a place with round-tripped coordinates", async () => {
    const res = await postPlace(adminA.accessToken, {
      title: "Old Dock Market",
      description: "A market",
      lng: LONDON.lng,
      lat: LONDON.lat,
      attrs: { indoor: true },
      status: "published",
    });
    expect(res.statusCode).toBe(201);
    const place = res.json().data.place as ApiPlace;
    expect(place.status).toBe("published");
    expect(place.hostUserId).toBe(adminA.userId);
    expect(Math.abs(place.lat - LONDON.lat)).toBeLessThan(1e-7);
    expect(Math.abs(place.lng - LONDON.lng)).toBeLessThan(1e-7);
    expect(place.attrs).toEqual({ indoor: true });
    expect(place.distanceM).toBeUndefined();
  });

  it("FR-GEO-002: explorer cannot create a place", async () => {
    const explorer = await makeMember(adminA, "explorer");
    const res = await postPlace(explorer.accessToken, {
      title: "Nope",
      lng: LONDON.lng,
      lat: LONDON.lat,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("FR-GEO-002: tenant_admin may attribute a place to another host; a host may not", async () => {
    const host = await makeMember(adminA, "host");
    const byAdmin = await postPlace(adminA.accessToken, {
      title: "Admin-made",
      lng: LONDON.lng,
      lat: LONDON.lat,
      hostUserId: host.userId,
    });
    expect(byAdmin.statusCode).toBe(201);
    expect(byAdmin.json().data.place.hostUserId).toBe(host.userId);

    const byHost = await postPlace(host.accessToken, {
      title: "Host sneak",
      lng: LONDON.lng,
      lat: LONDON.lat,
      hostUserId: adminA.userId,
    });
    expect(byHost.statusCode).toBe(403);
  });

  it("TR-TEST-003: tenant B gets 404 for A's place; B's lists never contain it", async () => {
    const place = await createPlace(adminA.accessToken, { status: "published" });
    const res = await getPlace(adminB.accessToken, place.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");

    const list = await listPlaces(adminB.accessToken);
    expect(list.statusCode).toBe(200);
    expect((list.json().data as ApiPlace[]).map((p) => p.id)).not.toContain(
      place.id,
    );
  });

  it("FR-GEO-003/TR-SEC-004: drafts are owner/admin only and stay out of lists", async () => {
    const host = await makeMember(adminA, "host");
    const explorer = await makeMember(adminA, "explorer");
    const draft = await createPlace(host.accessToken, {
      status: "draft",
      title: "Draft venue",
    });

    expect((await getPlace(host.accessToken, draft.id)).statusCode).toBe(200);
    expect((await getPlace(adminA.accessToken, draft.id)).statusCode).toBe(200);
    expect((await getPlace(explorer.accessToken, draft.id)).statusCode).toBe(
      404,
    );

    const list = await listPlaces(adminA.accessToken);
    expect(list.statusCode).toBe(200);
    expect((list.json().data as ApiPlace[]).map((p) => p.id)).not.toContain(
      draft.id,
    );
  });

  it("TR-TEST-004/FR-GEO-004/005: radius returns inside points only, nearest first, distanceM integer", async () => {
    const geo = await registerTenantUser(app, "near");
    const near1 = await createPlace(geo.accessToken, {
      lng: LONDON.lng + 0.001,
      title: "Near 1",
    });
    const near2 = await createPlace(geo.accessToken, {
      lng: LONDON.lng + 0.003,
      title: "Near 2",
    });
    const far = await createPlace(geo.accessToken, {
      lng: LONDON.lng + 0.02,
      title: "Far",
    });

    const res = await listPlaces(
      geo.accessToken,
      `?lat=${LONDON.lat}&lng=${LONDON.lng}&radiusM=800`,
    );
    expect(res.statusCode).toBe(200);
    const data = res.json().data as ApiPlace[];
    expect(data.map((p) => p.id)).toEqual([near1.id, near2.id]);
    const [first, second] = data;
    expect(Number.isInteger(first!.distanceM)).toBe(true);
    expect(first!.distanceM).toBeGreaterThan(50);
    expect(first!.distanceM).toBeLessThan(90);
    expect(second!.distanceM).toBeGreaterThan(first!.distanceM!);
    expect(data.map((p) => p.id)).not.toContain(far.id);
  });

  it("FR-GEO-006: bbox excludes points outside the envelope", async () => {
    const geo = await registerTenantUser(app, "bbox");
    const inside = await createPlace(geo.accessToken, {
      lng: -0.13,
      lat: 51.507,
    });
    const outside = await createPlace(geo.accessToken, {
      lng: -0.1,
      lat: 51.507,
    });

    const res = await listPlaces(geo.accessToken, "?bbox=-0.14,51.50,-0.12,51.52");
    expect(res.statusCode).toBe(200);
    const data = res.json().data as ApiPlace[];
    expect(data.map((p) => p.id)).toEqual([inside.id]);
    expect(data.map((p) => p.id)).not.toContain(outside.id);
  });

  it("FR-GEO-007/10.4: invalid geo parameters are 400 VALIDATION", async () => {
    const cases: Array<[string, string]> = [
      ["?lat=51.5&lng=-0.12&radiusM=10", "radius below min"],
      ["?lat=51.5&lng=-0.12&radiusM=50001", "radius above max"],
      ["?lat=51.5", "lat without lng"],
      ["?radiusM=100", "radius without lat/lng"],
      ["?bbox=-0.14,51.50,-0.12", "malformed bbox"],
      ["?bbox=-0.12,51.50,-0.14,51.52", "bbox west >= east"],
      ["?bbox=-0.14,51.50,-0.12,51.52&lat=51.5&lng=-0.12", "bbox + radius"],
      ["?cursor=not-a-cursor", "malformed cursor"],
    ];
    for (const [qs, label] of cases) {
      const res = await listPlaces(adminA.accessToken, qs);
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error.code, label).toBe("VALIDATION");
    }
  });

  it("FR-GEO-010: radius and recency lists paginate with opaque cursors", async () => {
    const paging = await registerTenantUser(app, "paging");
    const p1 = await createPlace(paging.accessToken, {
      lng: LONDON.lng + 0.001,
    });
    const p2 = await createPlace(paging.accessToken, {
      lng: LONDON.lng + 0.002,
    });
    const p3 = await createPlace(paging.accessToken, {
      lng: LONDON.lng + 0.003,
    });

    // Radius ordering: nearest first, `{ d, id }` cursor.
    const page1 = (
      await listPlaces(
        paging.accessToken,
        `?lat=${LONDON.lat}&lng=${LONDON.lng}&radiusM=800&limit=2`,
      )
    ).json();
    expect((page1.data as ApiPlace[]).map((p) => p.id)).toEqual([p1.id, p2.id]);
    expect(page1.meta.pagination.nextCursor).toBeTypeOf("string");

    const page2 = (
      await listPlaces(
        paging.accessToken,
        `?lat=${LONDON.lat}&lng=${LONDON.lng}&radiusM=800&limit=2&cursor=${page1.meta.pagination.nextCursor}`,
      )
    ).json();
    expect((page2.data as ApiPlace[]).map((p) => p.id)).toEqual([p3.id]);
    expect(page2.meta.pagination.nextCursor).toBeNull();

    // Recency ordering: newest first, `{ t, id }` cursor.
    const rec1 = (await listPlaces(paging.accessToken, "?limit=2")).json();
    expect((rec1.data as ApiPlace[]).map((p) => p.id)).toEqual([p3.id, p2.id]);
    const rec2 = (
      await listPlaces(
        paging.accessToken,
        `?limit=2&cursor=${rec1.meta.pagination.nextCursor}`,
      )
    ).json();
    expect((rec2.data as ApiPlace[]).map((p) => p.id)).toEqual([p1.id]);
    expect(rec2.meta.pagination.nextCursor).toBeNull();
  });

  it("FR-GEO-008: tenant boundary rejects places outside it", async () => {
    const tenant = await registerTenantUser(app, "boundary");
    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/admin/tenant",
      headers: authed(tenant.accessToken),
      payload: {
        boundary: {
          type: "Polygon",
          coordinates: [
            [
              [-0.2, 51.45],
              [-0.1, 51.45],
              [-0.1, 51.55],
              [-0.2, 51.55],
              [-0.2, 51.45],
            ],
          ],
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    const inside = await postPlace(tenant.accessToken, {
      title: "Inside",
      lng: -0.15,
      lat: 51.5,
    });
    expect(inside.statusCode).toBe(201);

    const outside = await postPlace(tenant.accessToken, {
      title: "Outside",
      lng: -0.5,
      lat: 51.5,
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error.code).toBe("OUTSIDE_BOUNDARY");

    // self-intersecting ring is a valid GeoJSON shape but not a valid polygon
    const bowtie = await app.inject({
      method: "PATCH",
      url: "/v1/admin/tenant",
      headers: authed(tenant.accessToken),
      payload: {
        boundary: {
          type: "Polygon",
          coordinates: [
            [
              [-0.2, 51.45],
              [-0.1, 51.55],
              [-0.1, 51.45],
              [-0.2, 51.55],
              [-0.2, 51.45],
            ],
          ],
        },
      },
    });
    expect(bowtie.statusCode).toBe(400);
    expect(bowtie.json().error.code).toBe("VALIDATION");
  });

  it("spatial functions use the same GUC as RLS: no context → no rows, foreign tenant → no rows, never drafts", async () => {
    const published = await createPlace(adminA.accessToken, {
      status: "published",
    });
    const draft = await createPlace(adminA.accessToken, { status: "draft" });

    const bare = await appSql.begin(
      async (tx) =>
        tx<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM place_ids_within_radius(${LONDON.lng}, ${LONDON.lat}, 50000, NULL, NULL, 100)
        `,
    );
    expect(bare[0]!.count).toBe(0);

    const seen = await withContext(
      { tenantId: adminA.tenantId, userId: adminA.userId, role: "tenant_admin" },
      (tx) =>
        tx<{ place_id: string }[]>`
          SELECT place_id
          FROM place_ids_within_radius(${LONDON.lng}, ${LONDON.lat}, 50000, NULL, NULL, 100)
        `,
    );
    const ids = seen.map((row) => row.place_id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(draft.id);

    const asB = await withContext(
      { tenantId: adminB.tenantId, userId: adminB.userId, role: "tenant_admin" },
      (tx) =>
        tx<{ place_id: string }[]>`
          SELECT place_id
          FROM place_ids_within_radius(${LONDON.lng}, ${LONDON.lat}, 50000, NULL, NULL, 100)
        `,
    );
    expect(asB).toEqual([]);

    // Even holding a candidate id, the RLS-gated fetch is still the gate.
    const stolen = await withContext(
      { tenantId: adminB.tenantId, userId: adminB.userId, role: "tenant_admin" },
      (tx) =>
        tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM places WHERE id = ${published.id}
        `,
    );
    expect(stolen[0]!.count).toBe(0);
  });

  it("RLS: no SET LOCAL → zero rows; B cannot update A's place; explorer insert rejected", async () => {
    const place = await createPlace(adminA.accessToken, { status: "published" });
    const explorer = await makeMember(adminA, "explorer");

    const bare = await appSql.begin(
      async (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM places`,
    );
    expect(bare[0]!.count).toBe(0);

    const updated = await withContext(
      { tenantId: adminB.tenantId, userId: adminB.userId, role: "tenant_admin" },
      async (tx) =>
        (await tx`UPDATE places SET title = 'hacked' WHERE id = ${place.id}`)
          .count,
    );
    expect(updated).toBe(0);
    const still = await getPlace(adminA.accessToken, place.id);
    expect(still.json().data.place.title).not.toBe("hacked");

    await expect(
      withContext(
        { tenantId: adminA.tenantId, userId: explorer.userId, role: "explorer" },
        async (tx) => {
          await tx`
            INSERT INTO places (tenant_id, host_user_id, title, geog)
            VALUES (
              ${adminA.tenantId},
              ${explorer.userId},
              'sneaky',
              ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography
            )
          `;
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("exit criteria: near-me uses places_geog_gix on seeded data (owner plan = function plan)", async () => {
    const geoAdmin = await registerTenantUser(app, "explain");
    const migrateSql = postgres(TEST_MIGRATE_URL, { max: 1 });
    try {
      await migrateSql.begin(async (tx) => {
        await tx`
          INSERT INTO places (tenant_id, host_user_id, title, status, geog)
          SELECT ${geoAdmin.tenantId}, ${geoAdmin.userId}, 'seed ' || g, 'published',
                 ST_SetSRID(
                   ST_MakePoint(
                     ${LONDON.lng} + (random() - 0.5) * 0.2,
                     ${LONDON.lat} + (random() - 0.5) * 0.2
                   ),
                   4326
                 )::geography
          FROM generate_series(1, 1200) AS g
        `;
        await tx`ANALYZE places`;
      });

      const plan = await migrateSql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${geoAdmin.tenantId}, true)`;
        const rows = await tx<{ "QUERY PLAN": string }[]>`
          EXPLAIN (ANALYZE, BUFFERS)
          WITH origin AS (
            SELECT ST_SetSRID(ST_MakePoint(${LONDON.lng}, ${LONDON.lat}), 4326)::geography AS point
          )
          SELECT p.id AS place_id,
                 round(ST_Distance(p.geog, origin.point))::int AS distance_m
          FROM places p, origin
          WHERE p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
            AND p.status = 'published'
            AND ST_DWithin(p.geog, origin.point, 1000)
          ORDER BY distance_m, place_id
          LIMIT 21
        `;
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });

      expect(plan).toContain("places_geog_gix");
      expect(plan).toContain("Index Scan");
    } finally {
      await migrateSql.end({ timeout: 5 });
    }
  });
});
