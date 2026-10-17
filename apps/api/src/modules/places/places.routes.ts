import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "@sinclair/typebox";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { activeTenantId, authOf } from "../../http/plugins/auth.js";
import { decodeCursor, type Cursor } from "../../lib/cursor.js";
import { Meta, PaginatedMeta } from "../../lib/envelope.js";
import { AppError } from "../../lib/errors.js";
import { findMembership } from "../identity/identity.service.js";
import { embedRow, type EmbeddingProvider } from "../search/embeddings.js";
import { PlaceDto } from "./dto.js";
import {
  createPlace,
  getPlace,
  isOutsideTenantBoundary,
  listPlaces,
  toPlaceDto,
} from "./places.service.js";

type PlacesRoutesOpts = { db: Db; embedder: EmbeddingProvider };

const CreatePlaceBody = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  lng: Type.Number({ minimum: -180, maximum: 180 }),
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  attrs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  status: Type.Optional(
    Type.Union([Type.Literal("draft"), Type.Literal("published")]),
  ),
  hostUserId: Type.Optional(Type.String({ format: "uuid" })),
});

const PlaceParams = Type.Object({ id: Type.String({ format: "uuid" }) });

// FR-GEO-007: radius bounds enforced by the schema (400 VALIDATION).
const ListPlacesQuery = Type.Object({
  lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  radiusM: Type.Optional(Type.Integer({ minimum: 50, maximum: 50_000 })),
  bbox: Type.Optional(
    Type.String({ pattern: "^-?\\d+(\\.\\d+)?(,-?\\d+(\\.\\d+)?){3}$" }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});

type ListPlacesQueryT = Static<typeof ListPlacesQuery>;

type ParsedListQuery = {
  origin?: { lng: number; lat: number };
  radiusM?: number;
  bbox?: { west: number; south: number; east: number; north: number };
  limit: number;
  cursor?: Cursor;
};

function parseListQuery(query: ListPlacesQueryT): ParsedListQuery {
  if ((query.lat === undefined) !== (query.lng === undefined)) {
    throw new AppError(
      "VALIDATION",
      400,
      "lat and lng must be provided together",
    );
  }
  if (query.radiusM !== undefined && query.lat === undefined) {
    throw new AppError("VALIDATION", 400, "radiusM requires lat and lng");
  }
  if (query.bbox !== undefined && query.lat !== undefined) {
    throw new AppError(
      "VALIDATION",
      400,
      "bbox cannot be combined with lat/lng/radiusM",
    );
  }

  let bbox: ParsedListQuery["bbox"];
  if (query.bbox !== undefined) {
    const [west, south, east, north] = query.bbox
      .split(",")
      .map(Number) as [number, number, number, number];
    if (
      west < -180 ||
      east > 180 ||
      south < -90 ||
      north > 90 ||
      west >= east ||
      south >= north
    ) {
      throw new AppError(
        "VALIDATION",
        400,
        "bbox must be west,south,east,north with west<east and south<north",
      );
    }
    bbox = { west, south, east, north };
  }

  const origin =
    query.lat !== undefined && query.lng !== undefined
      ? { lng: query.lng, lat: query.lat }
      : undefined;

  let cursor: Cursor | undefined;
  if (query.cursor !== undefined) {
    cursor = decodeCursor(query.cursor);
    const matchesOrdering = origin
      ? cursor.d !== undefined
      : cursor.t !== undefined;
    if (!matchesOrdering) {
      throw new AppError("VALIDATION", 400, "Malformed cursor");
    }
  }

  return {
    ...(origin ? { origin } : {}),
    ...(query.radiusM !== undefined ? { radiusM: query.radiusM } : {}),
    ...(bbox ? { bbox } : {}),
    limit: query.limit ?? 20,
    ...(cursor ? { cursor } : {}),
  };
}

export const placesRoutes: FastifyPluginAsyncTypebox<PlacesRoutesOpts> = async (
  app,
  opts,
) => {
  const { db, embedder } = opts;

  app.post(
    "/places",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        body: CreatePlaceBody,
        response: {
          201: Type.Object({
            data: Type.Object({ place: PlaceDto }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);
      const body = request.body;

      const place = await withRls(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        async (tx) => {
          // TR §6: mutating routes re-check membership in the transaction and
          // use the DB role (the JWT role is only a hint).
          const membership = await findMembership(tx, tenantId, auth.userId);
          if (
            !membership ||
            (membership.role !== "host" && membership.role !== "tenant_admin")
          ) {
            throw new AppError(
              "FORBIDDEN",
              403,
              "Host or tenant admin access required",
            );
          }
          await tx`select set_config('app.role', ${membership.role}, true)`;

          // FR-GEO-002: caller hosts the place unless a tenant_admin
          // attributes it to another member of the tenant.
          let hostUserId = auth.userId;
          if (body.hostUserId !== undefined && body.hostUserId !== auth.userId) {
            if (membership.role !== "tenant_admin") {
              throw new AppError(
                "FORBIDDEN",
                403,
                "Only a tenant admin can set another host",
              );
            }
            const target = await findMembership(tx, tenantId, body.hostUserId);
            if (
              !target ||
              (target.role !== "host" && target.role !== "tenant_admin")
            ) {
              throw new AppError(
                "VALIDATION",
                400,
                "hostUserId must be a host or tenant admin of this tenant",
              );
            }
            hostUserId = body.hostUserId;
          }

          if (await isOutsideTenantBoundary(tx, tenantId, body.lng, body.lat)) {
            throw new AppError(
              "OUTSIDE_BOUNDARY",
              400,
              "Point is outside the tenant boundary",
            );
          }

          return createPlace(tx, {
            tenantId,
            hostUserId,
            title: body.title,
            description: body.description ?? null,
            status: body.status ?? "draft",
            lng: body.lng,
            lat: body.lat,
            attrs: body.attrs ?? {},
          });
        },
      );

      // FR-SRCH-002 / TR §18: text is committed by now; a provider failure just
      // leaves embedding_stale = true for the Phase 6 backfill job.
      try {
        await embedRow(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          "places",
          place.id,
          `${place.title} ${place.description ?? ""}`,
          embedder,
        );
      } catch (err) {
        request.log.warn(
          { err, placeId: place.id },
          "place embedding failed; row left stale",
        );
      }

      return reply.status(201).send({
        data: { place: toPlaceDto(place) },
        meta: { requestId: request.requestId },
      });
    },
  );

  app.get(
    "/places",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        querystring: ListPlacesQuery,
        response: {
          200: Type.Object({
            data: Type.Array(PlaceDto),
            meta: PaginatedMeta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);
      const query = parseListQuery(request.query);

      const { items, nextCursor } = await withRls(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        (tx) => listPlaces(tx, query),
      );

      return reply.send({
        data: items.map(toPlaceDto),
        meta: {
          requestId: request.requestId,
          pagination: { nextCursor },
        },
      });
    },
  );

  app.get(
    "/places/:id",
    {
      preHandler: app.requireTenantAuth,
      schema: {
        params: PlaceParams,
        response: {
          200: Type.Object({
            data: Type.Object({ place: PlaceDto }),
            meta: Meta,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const tenantId = activeTenantId(request);

      const place = await withRls(
        db,
        { tenantId, userId: auth.userId, role: auth.role },
        (tx) => getPlace(tx, request.params.id),
      );
      if (!place) {
        throw new AppError("NOT_FOUND", 404, "Place not found");
      }

      return reply.send({
        data: { place: toPlaceDto(place) },
        meta: { requestId: request.requestId },
      });
    },
  );
};

export default placesRoutes;
