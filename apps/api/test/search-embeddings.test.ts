import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres, { type TransactionSql } from "postgres";
import {
  buildTestApp,
  registerTenantUser,
  TEST_DATABASE_URL,
  TEST_MIGRATE_URL,
  testConfig,
  type TenantUserSeed,
} from "./helpers.js";
import { createEmbeddingProvider } from "../src/modules/search/embeddings.js";

type ApiHit = {
  kind: "place" | "experience";
  id: string;
  title: string;
  score: number;
  distanceM?: number;
};

describe("hybrid search & embeddings (FR-SRCH-*, Phase 4)", () => {
  let app: FastifyInstance;
  const appSql = postgres(TEST_DATABASE_URL, { max: 4 });
  const migSql = postgres(TEST_MIGRATE_URL, { max: 2 });

  let adminA: TenantUserSeed;
  let adminB: TenantUserSeed;

  beforeAll(async () => {
    app = await buildTestApp();
    adminA = await registerTenantUser(app, "srch-a");
    adminB = await registerTenantUser(app, "srch-b");
  });

  afterAll(async () => {
    await app.close();
    await appSql.end({ timeout: 5 });
    await migSql.end({ timeout: 5 });
  });

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
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

  async function createPlace(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/places",
      headers: authed(token),
      payload: {
        status: "published",
        lng: -0.12,
        lat: 51.5,
        ...payload,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.place.id as string;
  }

  async function setEmbedding(
    table: "places" | "experiences",
    id: string,
    vector: number[],
  ): Promise<void> {
    const literal = `[${vector.join(",")}]`;
    if (table === "places") {
      await migSql`
        UPDATE places SET embedding = ${literal}::vector, embedding_stale = false
        WHERE id = ${id}
      `;
    } else {
      await migSql`
        UPDATE experiences SET embedding = ${literal}::vector, embedding_stale = false
        WHERE id = ${id}
      `;
    }
  }

  async function setRanking(tenantId: string, ranking: Record<string, number>) {
    await migSql`
      UPDATE tenants SET settings = settings || ${migSql.json({ ranking })}::jsonb
      WHERE id = ${tenantId}
    `;
  }

  async function search(
    token: string,
    query: string,
  ): Promise<{ statusCode: number; hits: ApiHit[] }> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?${query}`,
      headers: authed(token),
    });
    return {
      statusCode: res.statusCode,
      hits: res.statusCode === 200 ? (res.json().data as ApiHit[]) : [],
    };
  }

  it("mock provider is deterministic and right-sized (TR-TEST-006)", async () => {
    const provider = createEmbeddingProvider(testConfig());
    const [a1] = await provider.embed(["quiet sunset tasting"]);
    const [a2] = await provider.embed(["quiet sunset tasting"]);
    const [b] = await provider.embed(["something else"]);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1!.length).toBe(provider.dim);
  });

  it("embeds searchable text on write, and clears embedding_stale", async () => {
    const placeId = await createPlace(adminA.accessToken, {
      title: "Rooftop jazz bar",
      description: "Live jazz nightly",
    });
    const rows = await withContext({ tenantId: adminA.tenantId }, (tx) =>
      tx<{ has: boolean; stale: boolean }[]>`
        SELECT embedding IS NOT NULL AS has, embedding_stale AS stale
        FROM places WHERE id = ${placeId}
      `,
    );
    expect(rows[0]!.has).toBe(true);
    expect(rows[0]!.stale).toBe(false);
  });

  it("requires q or geo (FR-SRCH-005)", async () => {
    const missingQ = await search(adminA.accessToken, "limit=5");
    expect(missingQ.statusCode).toBe(400);
    expect(missingQ.hits).toEqual([]);

    const blankQ = await app.inject({
      method: "GET",
      url: "/v1/search?q=%20%20&limit=5",
      headers: authed(adminA.accessToken),
    });
    expect(blankQ.statusCode).toBe(400);
    expect(blankQ.json().error.code).toBe("SEARCH_UNCONSTRAINED");
  });

  it("text-only keys on the keyword, hybrid keys on the neighbour (FR-SRCH-004)", async () => {
    const provider = createEmbeddingProvider(testConfig());
    const [qvec] = await provider.embed(["zephyr"]);
    const opposite = qvec!.map((v) => -v);

    // Two published rows whose keyword and semantic signals disagree: the
    // keyword hit is semantically opposite the query, and vice versa.
    const keywordId = await createPlace(adminA.accessToken, {
      title: "zephyr night",
    });
    const semanticId = await createPlace(adminA.accessToken, {
      title: "quiet evening",
    });
    await setEmbedding("places", keywordId, opposite);
    await setEmbedding("places", semanticId, qvec!);

    await setRanking(adminA.tenantId, {
      text: 1,
      semantic: 0,
      geo: 0,
      popularity: 0,
    });
    const textOnly = await search(
      adminA.accessToken,
      "q=zephyr&kind=place&limit=10",
    );
    expect(textOnly.hits[0]?.id).toBe(keywordId);

    await setRanking(adminA.tenantId, {
      text: 0,
      semantic: 1,
      geo: 0,
      popularity: 0,
    });
    const hybrid = await search(
      adminA.accessToken,
      "q=zephyr&kind=place&limit=10",
    );
    expect(hybrid.hits[0]?.id).toBe(semanticId);
  });

  it("never returns another tenant's rows", async () => {
    const mineId = await createPlace(adminA.accessToken, {
      title: "onlyminealpha",
    });
    const theirsId = await createPlace(adminB.accessToken, {
      title: "onlyminebeta",
    });

    const a = await search(
      adminA.accessToken,
      "q=onlyminealpha&kind=place&limit=50",
    );
    expect(a.hits.map((h) => h.id)).toContain(mineId);
    expect(a.hits.map((h) => h.id)).not.toContain(theirsId);
  });

  it("serves naive recommendations bounded by limit (FR-REC-001)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/recommendations?limit=5",
      headers: authed(adminA.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeLessThanOrEqual(5);
  });

  it("has the HNSW cosine indexes (exit criteria)", async () => {
    const rows = await migSql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname LIKE '%\_embedding\_hnsw' ESCAPE '\'
      ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname)).toEqual([
      "experiences_embedding_hnsw",
      "places_embedding_hnsw",
    ]);
  });
});
