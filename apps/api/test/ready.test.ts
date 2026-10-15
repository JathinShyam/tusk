import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Ready checks need a real Postgres with extensions.
 * Prefer Compose (`DATABASE_URL` from `.env`); fall back to the default local DSN.
 * (Testcontainers/Ryuk is unreliable on some Docker setups — Compose is the Phase 0 path.)
 */
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://tusk_app:tusk_app@localhost:5432/tusk";

describe("GET /v1/ready", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: "error",
    });
    app = await buildApp({ config });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 when Postgres accepts SELECT 1", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { status: string };
      meta: { requestId: string };
    };
    expect(body.data.status).toBe("ready");
    expect(body.meta.requestId).toBeTruthy();
  });

  it("returns 503 when the database is unreachable", async () => {
    const broken = await buildApp({
      config: loadConfig({
        ...process.env,
        DATABASE_URL: "postgres://tusk_app:wrong@127.0.0.1:1/tusk",
        LOG_LEVEL: "error",
      }),
    });
    try {
      const res = await broken.inject({ method: "GET", url: "/v1/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json() as {
        error: { code: string; message: string };
        meta: { requestId: string };
      };
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).toBe("Database unavailable");
      expect(body.meta.requestId).toBeTruthy();
    } finally {
      await broken.close();
    }
  });
});
