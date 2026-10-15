export type AppConfig = {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  databaseMigrateUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  embeddingProvider: "openai" | "voyage" | "mock";
  embeddingApiKey: string;
  embeddingDim: number;
  allowSelfTenant: boolean;
  corsOrigins: string[];
};

function bool(name: string, env: NodeJS.ProcessEnv, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseEmbeddingProvider(
  value: string | undefined,
): AppConfig["embeddingProvider"] {
  const v = value ?? "mock";
  if (v === "openai" || v === "voyage" || v === "mock") return v;
  throw new Error(`Invalid EMBEDDING_PROVIDER: ${v}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  const nodeEnv = env.NODE_ENV ?? "development";
  const jwtAccessSecret = env.JWT_ACCESS_SECRET ?? "dev-access-secret-change-me";
  const jwtRefreshSecret = env.JWT_REFRESH_SECRET ?? "dev-refresh-secret-change-me";
  if (
    nodeEnv === "production" &&
    (jwtAccessSecret === "dev-access-secret-change-me" ||
      jwtRefreshSecret === "dev-refresh-secret-change-me")
  ) {
    throw new Error(
      "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in production",
    );
  }

  return {
    nodeEnv,
    port: Number(env.PORT ?? "3000"),
    logLevel: env.LOG_LEVEL ?? "info",
    databaseUrl,
    databaseMigrateUrl: env.DATABASE_MIGRATE_URL ?? "",
    jwtAccessSecret,
    jwtRefreshSecret,
    embeddingProvider: parseEmbeddingProvider(env.EMBEDDING_PROVIDER),
    embeddingApiKey: env.EMBEDDING_API_KEY ?? "",
    embeddingDim: Number(env.EMBEDDING_DIM ?? "1536"),
    allowSelfTenant: bool("ALLOW_SELF_TENANT", env, false),
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
