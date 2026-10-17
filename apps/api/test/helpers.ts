import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://tusk_app:tusk_app@localhost:5432/tusk";

export const TEST_MIGRATE_URL =
  process.env.DATABASE_MIGRATE_URL ??
  "postgres://tusk_migrator:tusk_migrator@localhost:5432/tusk";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: "error",
      ALLOW_SELF_TENANT: "true",
    }),
    ...overrides,
  };
}

export async function buildTestApp(
  overrides: Partial<AppConfig> = {},
): Promise<FastifyInstance> {
  return buildApp({ config: testConfig(overrides) });
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

export function randomSuffix(): string {
  return randomUUID().slice(0, 8);
}

export const TEST_PASSWORD = "correct-horse-battery-staple";

export type TenantUserSeed = {
  email: string;
  userId: string;
  tenantId: string;
  accessToken: string;
};

/** Register a user with a fresh tenant (tenant_admin membership). */
export async function registerTenantUser(
  app: FastifyInstance,
  prefix: string,
): Promise<TenantUserSeed> {
  const email = uniqueEmail(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email,
      password: TEST_PASSWORD,
      tenant: { name: `Tenant ${prefix} ${randomSuffix()}` },
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed (${res.statusCode}): ${res.body}`);
  }
  const data = res.json().data;
  return {
    email,
    userId: data.user.id,
    tenantId: data.tenant.id,
    accessToken: data.accessToken,
  };
}
