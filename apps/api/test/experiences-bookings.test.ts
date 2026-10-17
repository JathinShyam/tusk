import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres, { type TransactionSql } from "postgres";
import {
  buildTestApp,
  registerTenantUser,
  TEST_DATABASE_URL,
  type TenantUserSeed,
} from "./helpers.js";

type ApiExperience = {
  id: string;
  tenantId: string;
  placeId: string;
  hostUserId: string;
  status: string;
  priceMinor: number;
  currency: string;
};

type ApiSlot = {
  id: string;
  experienceId: string;
  startsAt: string;
  endsAt: string | null;
  capacity: number;
  status: string;
};

type ApiBooking = {
  id: string;
  tenantId: string;
  slotId: string;
  userId: string;
  partySize: number;
  status: string;
  amountMinor: number;
  currency: string;
};

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

describe("experiences & bookings (FR-EXP-*, Phase 3)", () => {
  let app: FastifyInstance;
  const appSql = postgres(TEST_DATABASE_URL, { max: 4 });

  let adminA: TenantUserSeed;
  let adminB: TenantUserSeed;

  beforeAll(async () => {
    app = await buildTestApp();
    adminA = await registerTenantUser(app, "exp-a");
    adminB = await registerTenantUser(app, "exp-b");
  });

  afterAll(async () => {
    await app.close();
    await appSql.end({ timeout: 5 });
  });

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

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

  async function withContext<T>(
    ctx: { tenantId?: string; userId?: string; role?: string },
    fn: (tx: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return appSql.begin(async (tx) => {
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
    }) as Promise<T>;
  }

  async function createPlace(token: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/places",
      headers: authed(token),
      payload: { title: "Venue", lng: -0.12, lat: 51.5, status: "published" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.place.id as string;
  }

  async function createExperience(
    token: string,
    overrides: Partial<{
      placeId: string;
      status: string;
      priceMinor: number;
    }> = {},
  ): Promise<ApiExperience> {
    const placeId = overrides.placeId ?? (await createPlace(token));
    const res = await app.inject({
      method: "POST",
      url: "/v1/experiences",
      headers: authed(token),
      payload: {
        placeId,
        title: "Sunset kayak",
        priceMinor: overrides.priceMinor ?? 2500,
        currency: "GBP",
        status: overrides.status ?? "published",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.experience as ApiExperience;
  }

  async function createSlot(
    token: string,
    experienceId: string,
    overrides: Partial<{
      startsAt: string;
      endsAt: string;
      capacity: number;
      status: string;
    }> = {},
  ): Promise<ApiSlot> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/experiences/${experienceId}/slots`,
      headers: authed(token),
      payload: {
        startsAt: overrides.startsAt ?? inHours(1),
        endsAt: overrides.endsAt ?? inHours(2),
        capacity: overrides.capacity ?? 4,
        ...(overrides.status ? { status: overrides.status } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.slot as ApiSlot;
  }

  async function book(
    token: string,
    experienceId: string,
    payload: { slotId: string; partySize: number },
    key: string,
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/experiences/${experienceId}/bookings`,
      headers: { ...authed(token), "idempotency-key": key },
      payload,
    });
  }

  function uniqueKey(): string {
    return `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }

  it("FR-EXP-001/003: host creates an experience; published ones list, drafts stay owner/admin only", async () => {
    const placeId = await createPlace(adminA.accessToken);
    const published = await createExperience(adminA.accessToken, { placeId });
    const draft = await createExperience(adminA.accessToken, {
      placeId,
      status: "draft",
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/experiences",
      headers: authed(adminA.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().data as ApiExperience[]).map((e) => e.id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(draft.id);

    const other = await makeMember(adminA, "explorer");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/experiences/${draft.id}`,
          headers: authed(other.accessToken),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("FR-EXP-002: explorer cannot create an experience", async () => {
    const explorer = await makeMember(adminA, "explorer");
    const res = await app.inject({
      method: "POST",
      url: "/v1/experiences",
      headers: authed(explorer.accessToken),
      payload: {
        placeId: await createPlace(adminA.accessToken),
        title: "Nope",
        priceMinor: 100,
        currency: "GBP",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("FR-EXP-004: overlapping open slots for one experience are 409 SLOT_OVERLAP", async () => {
    const experience = await createExperience(adminA.accessToken);
    await createSlot(adminA.accessToken, experience.id, {
      startsAt: inHours(1),
      endsAt: inHours(2),
    });
    const overlap = await app.inject({
      method: "POST",
      url: `/v1/experiences/${experience.id}/slots`,
      headers: authed(adminA.accessToken),
      payload: { startsAt: inHours(1.5), endsAt: inHours(2.5), capacity: 2 },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error.code).toBe("SLOT_OVERLAP");
  });

  it("TR-TEST-005: concurrent bookings never exceed capacity=1", async () => {
    const experience = await createExperience(adminA.accessToken);
    const slot = await createSlot(adminA.accessToken, experience.id, {
      capacity: 1,
    });
    const u1 = await makeMember(adminA, "explorer");
    const u2 = await makeMember(adminA, "explorer");

    const [r1, r2] = await Promise.all([
      book(u1.accessToken, experience.id, { slotId: slot.id, partySize: 1 }, uniqueKey()),
      book(u2.accessToken, experience.id, { slotId: slot.id, partySize: 1 }, uniqueKey()),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = r1.statusCode === 409 ? r1 : r2;
    expect(conflict.json().error.code).toBe("BOOKING_CAPACITY");
  });

  it("FR-EXP-006/008/013: capacity, double-book, and the price snapshot", async () => {
    const experience = await createExperience(adminA.accessToken, {
      priceMinor: 3300,
    });
    const slot = await createSlot(adminA.accessToken, experience.id, {
      capacity: 3,
    });
    const explorer = await makeMember(adminA, "explorer");

    const first = await book(
      explorer.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 2 },
      uniqueKey(),
    );
    expect(first.statusCode).toBe(201);
    const booking = first.json().data.booking as ApiBooking;
    expect(booking.amountMinor).toBe(3300);
    expect(booking.currency).toBe("GBP");
    expect(booking.status).toBe("confirmed");

    // capacity: 2 already booked, 2 more would oversell (from a fresh user)
    const other = await makeMember(adminA, "explorer");
    const over2 = await book(
      other.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 2 },
      uniqueKey(),
    );
    expect(over2.statusCode).toBe(409);
    expect(over2.json().error.code).toBe("BOOKING_CAPACITY");

    // FR-EXP-008: same user cannot double-book the same slot
    const dupe = await book(
      explorer.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      uniqueKey(),
    );
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe("BOOKING_CONFLICT");
  });

  it("FR-EXP-005: closed and past slots are rejected", async () => {
    const experience = await createExperience(adminA.accessToken);
    const past = await createSlot(adminA.accessToken, experience.id, {
      startsAt: inHours(-2),
      endsAt: inHours(-1),
    });
    const closed = await createSlot(adminA.accessToken, experience.id, {
      startsAt: inHours(3),
      endsAt: inHours(4),
      status: "closed",
    });
    const explorer = await makeMember(adminA, "explorer");

    const pastRes = await book(
      explorer.accessToken,
      experience.id,
      { slotId: past.id, partySize: 1 },
      uniqueKey(),
    );
    expect(pastRes.statusCode).toBe(400);
    expect(pastRes.json().error.code).toBe("SLOT_IN_PAST");

    const closedRes = await book(
      explorer.accessToken,
      experience.id,
      { slotId: closed.id, partySize: 1 },
      uniqueKey(),
    );
    expect(closedRes.statusCode).toBe(409);
    expect(closedRes.json().error.code).toBe("BOOKING_CONFLICT");
  });

  it("FR-EXP-009/010: Idempotency-Key is required; replay returns the same booking", async () => {
    const experience = await createExperience(adminA.accessToken);
    const slot = await createSlot(adminA.accessToken, experience.id, {
      capacity: 2,
    });
    const explorer = await makeMember(adminA, "explorer");

    const missing = await app.inject({
      method: "POST",
      url: `/v1/experiences/${experience.id}/bookings`,
      headers: authed(explorer.accessToken),
      payload: { slotId: slot.id, partySize: 1 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("VALIDATION");

    const key = uniqueKey();
    const first = await book(
      explorer.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      key,
    );
    expect(first.statusCode).toBe(201);
    const id = first.json().data.booking.id as string;

    const replay = await book(
      explorer.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      key,
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.booking.id).toBe(id);

    const changed = await book(
      explorer.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 2 },
      key,
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("FR-EXP-011: cancel frees capacity and is visible to the booker", async () => {
    const experience = await createExperience(adminA.accessToken);
    const slot = await createSlot(adminA.accessToken, experience.id, {
      capacity: 1,
    });
    const u1 = await makeMember(adminA, "explorer");
    const u2 = await makeMember(adminA, "explorer");

    const first = await book(
      u1.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      uniqueKey(),
    );
    expect(first.statusCode).toBe(201);
    const bookingId = first.json().data.booking.id as string;

    const cancel = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/cancel`,
      headers: authed(u1.accessToken),
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.booking.status).toBe("cancelled");

    const second = await book(
      u2.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      uniqueKey(),
    );
    expect(second.statusCode).toBe(201);
  });

  it("FR-EXP-012: explorer lists only own bookings; host sees bookings on their experience", async () => {
    const host = await makeMember(adminA, "host");
    const experience = await createExperience(host.accessToken);
    const slot = await createSlot(host.accessToken, experience.id, {
      capacity: 2,
    });
    const explorer = await makeMember(adminA, "explorer");

    const created = await book(
      explorer.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      uniqueKey(),
    );
    expect(created.statusCode).toBe(201);
    const bookingId = created.json().data.booking.id as string;

    const mine = await app.inject({
      method: "GET",
      url: "/v1/bookings",
      headers: authed(explorer.accessToken),
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json().data as ApiBooking[]).map((b) => b.id)).toContain(
      bookingId,
    );

    const hostList = await app.inject({
      method: "GET",
      url: "/v1/bookings",
      headers: authed(host.accessToken),
    });
    expect((hostList.json().data as ApiBooking[]).map((b) => b.id)).toContain(
      bookingId,
    );

    // A different explorer cannot see it.
    const stranger = await makeMember(adminA, "explorer");
    const strangerList = await app.inject({
      method: "GET",
      url: "/v1/bookings",
      headers: authed(stranger.accessToken),
    });
    expect((strangerList.json().data as ApiBooking[]).map((b) => b.id)).not.toContain(
      bookingId,
    );
  });

  it("TR isolation: tenant B cannot book or read tenant A's experience", async () => {
    const experience = await createExperience(adminA.accessToken);
    const slot = await createSlot(adminA.accessToken, experience.id, {
      capacity: 2,
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/experiences/${experience.id}`,
          headers: authed(adminB.accessToken),
        })
      ).statusCode,
    ).toBe(404);

    const asB = await book(
      adminB.accessToken,
      experience.id,
      { slotId: slot.id, partySize: 1 },
      uniqueKey(),
    );
    expect(asB.statusCode).toBe(404);
    expect(asB.json().error.code).toBe("NOT_FOUND");
  });

  it("RLS: no SET LOCAL → zero rows; a host cannot book for another user via direct SQL", async () => {
    const bare = await appSql.begin(
      async (tx) =>
        tx<{ count: number }[]>`SELECT count(*)::int AS count FROM bookings`,
    );
    expect(bare[0]!.count).toBe(0);

    const host = await makeMember(adminA, "host");
    const explorer = await makeMember(adminA, "explorer");
    const experience = await createExperience(host.accessToken);
    const slot = await createSlot(host.accessToken, experience.id, {
      capacity: 2,
    });

    await expect(
      withContext(
        { tenantId: adminA.tenantId, userId: host.userId, role: "host" },
        async (tx) => {
          await tx`
            INSERT INTO bookings
              (tenant_id, slot_id, user_id, party_size, amount_minor, currency)
            VALUES
              (${adminA.tenantId}, ${slot.id}, ${explorer.userId}, 1, 2500, 'GBP')
          `;
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
