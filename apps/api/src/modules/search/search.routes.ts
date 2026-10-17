import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { activeTenantId, authOf } from "../../http/plugins/auth.js";
import { decodeCursor } from "../../lib/cursor.js";
import { Meta, PaginatedMeta } from "../../lib/envelope.js";
import { AppError } from "../../lib/errors.js";
import { SearchHitDto } from "./dto.js";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  DEFAULT_RADIUS_M,
  loadRankingWeights,
  recommendationHits,
  searchHits,
} from "./search.service.js";

type SearchRoutesOpts = { db: Db; embedder: EmbeddingProvider };

const SearchQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 200 })),
  lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  radiusM: Type.Optional(Type.Integer({ minimum: 50, maximum: 50_000 })),
  kind: Type.Optional(
    Type.Union([Type.Literal("place"), Type.Literal("experience")]),
  ),
  categoryId: Type.Optional(Type.String({ format: "uuid" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});

const RecommendationQuery = Type.Object({
  lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  radiusM: Type.Optional(Type.Integer({ minimum: 50, maximum: 50_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const searchRoutes: FastifyPluginAsyncTypebox<SearchRoutesOpts> = async (
  app,
  opts,
) => {
  const { db, embedder } = opts;

  app.get(
    "/search",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        querystring: SearchQuery,
        response: {
          200: Type.Object({
            data: Type.Array(SearchHitDto),
            meta: PaginatedMeta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);
      const { lat, lng, radiusM, kind, categoryId } = request.query;
      const q = (request.query.q ?? "").trim();

      if ((lat === undefined) !== (lng === undefined)) {
        throw new AppError(
          "VALIDATION",
          400,
          "lat and lng must be provided together",
        );
      }
      if (radiusM !== undefined && lat === undefined) {
        throw new AppError("VALIDATION", 400, "radiusM requires lat and lng");
      }
      // FR-SRCH-005: with neither an intent nor a place there is nothing to rank.
      if (q.length === 0 && lat === undefined) {
        throw new AppError(
          "SEARCH_UNCONSTRAINED",
          400,
          "q or lat/lng is required",
        );
      }

      const cursor =
        request.query.cursor !== undefined
          ? decodeCursor(request.query.cursor)
          : undefined;
      if (cursor && cursor.s === undefined) {
        throw new AppError("VALIDATION", 400, "Malformed cursor");
      }

      // FR-SRCH-002: embed outside the transaction so an HTTP provider call
      // never holds a DB connection open.
      let embedding: number[] | null = null;
      if (q.length > 0) {
        try {
          embedding = (await embedder.embed([q]))[0] ?? null;
        } catch (err) {
          // PRD §7 decision: degrade to FTS+geo, never 5xx.
          request.log.warn(
            { err },
            "query embedding failed; ranking without semantic term",
          );
        }
      }

      const { items, nextCursor } = await withRls(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        async (tx) => {
          const weights = await loadRankingWeights(tx, tenantId);
          return searchHits(
            tx,
            {
              q,
              embedding,
              ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
              radiusM: radiusM ?? DEFAULT_RADIUS_M,
              ...(kind !== undefined ? { kind } : {}),
              ...(categoryId !== undefined ? { categoryId } : {}),
              limit: request.query.limit ?? 20,
              ...(cursor ? { cursor } : {}),
            },
            weights,
          );
        },
      );

      return reply.send({
        data: items,
        meta: {
          requestId: request.requestId,
          pagination: { nextCursor },
        },
      });
    },
  );

  app.get(
    "/recommendations",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        querystring: RecommendationQuery,
        response: {
          200: Type.Object({
            data: Type.Array(SearchHitDto),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);
      const { lat, lng, radiusM } = request.query;

      if ((lat === undefined) !== (lng === undefined)) {
        throw new AppError(
          "VALIDATION",
          400,
          "lat and lng must be provided together",
        );
      }
      if (radiusM !== undefined && lat === undefined) {
        throw new AppError("VALIDATION", 400, "radiusM requires lat and lng");
      }

      const items = await withRls(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        (tx) =>
          recommendationHits(tx, {
            userId: auth.userId,
            ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
            radiusM: radiusM ?? DEFAULT_RADIUS_M,
            limit: request.query.limit ?? 20,
          }),
      );

      return reply.send({
        data: items,
        meta: { requestId: request.requestId },
      });
    },
  );
};

export default searchRoutes;
