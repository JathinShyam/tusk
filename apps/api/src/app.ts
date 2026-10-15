import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  type TypeBoxTypeProvider,
} from "@fastify/type-provider-typebox";
import type { AppConfig } from "./config.js";
import { createDb, type Db } from "./db/client.js";
import authPlugin from "./http/plugins/auth.js";
import errorHandlerPlugin from "./http/plugins/error-handler.js";
import requestIdPlugin from "./http/plugins/request-id.js";
import healthRoutes from "./http/routes/health.js";
import authRoutes from "./modules/identity/auth.routes.js";
import meRoutes from "./modules/identity/me.routes.js";
import tenantsRoutes from "./modules/identity/tenants.routes.js";

export type AppDeps = {
  config: AppConfig;
  db?: Db;
};

export async function buildApp(deps: AppDeps) {
  const db = deps.db ?? createDb(deps.config);

  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate("db", db);

  await app.register(cors, { origin: deps.config.corsOrigins });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { config: deps.config });
  await app.register(healthRoutes, { prefix: "/v1", db });
  await app.register(authRoutes, {
    prefix: "/v1",
    db,
    config: deps.config,
  });
  await app.register(meRoutes, { prefix: "/v1", db });
  await app.register(tenantsRoutes, {
    prefix: "/v1",
    db,
    config: deps.config,
  });

  app.addHook("onClose", async () => {
    await db.end({ timeout: 5 });
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}
