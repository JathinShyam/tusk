import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = { DATABASE_URL: "postgres://app:app@localhost:5432/tusk" };

describe("loadConfig", () => {
  it("requires real JWT secrets in production", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production" })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: "dev-access-secret-change-me",
        JWT_REFRESH_SECRET: "long-random-refresh-secret",
      }),
    ).toThrow(/JWT_REFRESH_SECRET/);
  });

  it("allows dev defaults outside production", () => {
    const config = loadConfig(BASE);
    expect(config.nodeEnv).toBe("development");
    expect(config.jwtAccessSecret).toBeTruthy();
    expect(config.corsOrigins).toEqual(["http://localhost:3000"]);
  });
});
