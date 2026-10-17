import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { activeTenantId, authOf } from "../../http/plugins/auth.js";
import { decodeCursor } from "../../lib/cursor.js";
import { Meta, PaginatedMeta } from "../../lib/envelope.js";
import { AppError } from "../../lib/errors.js";
import { findMembership } from "../identity/identity.service.js";
import { embedRow, type EmbeddingProvider } from "../search/embeddings.js";
import { BookingDto, ExperienceDto, SlotDto } from "./dto.js";
import {
  createExperience,
  createSlot,
  getExperience,
  listExperiences,
  listSlots,
  toExperienceDto,
  toSlotDto,
} from "./experiences.service.js";
import {
  createBooking,
  toBookingDto,
} from "./bookings.service.js";
import { createHash } from "node:crypto";

type ExperienceRoutesOpts = { db: Db; embedder: EmbeddingProvider };

const CreateExperienceBody = Type.Object({
  placeId: Type.String({ format: "uuid" }),
  categoryId: Type.Optional(Type.String({ format: "uuid" })),
  title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  priceMinor: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  attrs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  status: Type.Optional(
    Type.Union([Type.Literal("draft"), Type.Literal("published")]),
  ),
});

const CreateSlotBody = Type.Object({
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  capacity: Type.Integer({ minimum: 1, maximum: 100_000 }),
  status: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  ),
});

const IdParams = Type.Object({ id: Type.String({ format: "uuid" }) });

const ListExperiencesQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});

const IdempotencyHeaders = Type.Object({
  "idempotency-key": Type.String({ minLength: 1, maxLength: 255 }),
});

const CreateBookingBody = Type.Object({
  slotId: Type.String({ format: "uuid" }),
  partySize: Type.Integer({ minimum: 1, maximum: 100 }),
  externalPaymentId: Type.Optional(Type.String({ maxLength: 255 })),
});

function parseLimit(raw: number | undefined): number {
  return raw ?? 20;
}

export const experiencesRoutes: FastifyPluginAsyncTypebox<ExperienceRoutesOpts> =
  async (app, opts) => {
    const { db, embedder } = opts;

    app.post(
      "/experiences",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          body: CreateExperienceBody,
          response: {
            201: Type.Object({
              data: Type.Object({ experience: ExperienceDto }),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);
        const body = request.body;

        const experience = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (tx) => {
            // TR §6: re-check membership in-tx; the JWT role is only a hint.
            const membership = await findMembership(tx, tenantId, auth.userId);
            if (
              !membership ||
              (membership.role !== "host" &&
                membership.role !== "tenant_admin")
            ) {
              throw new AppError(
                "FORBIDDEN",
                403,
                "Host or tenant admin access required",
              );
            }
            await tx`select set_config('app.role', ${membership.role}, true)`;

            // FR-EXP-001: the place must be visible in this tenant (RLS), and
            // the composite FK then guarantees the same tenant at insert.
            const place = await tx<{ id: string }[]>`
              SELECT id FROM places WHERE id = ${body.placeId}
            `;
            if (place.length === 0) {
              throw new AppError(
                "VALIDATION",
                400,
                "placeId must reference a place in this tenant",
              );
            }
            if (body.categoryId !== undefined) {
              const category = await tx<{ id: string }[]>`
                SELECT id FROM categories WHERE id = ${body.categoryId}
              `;
              if (category.length === 0) {
                throw new AppError(
                  "VALIDATION",
                  400,
                  "categoryId must reference a category in this tenant",
                );
              }
            }

            return createExperience(tx, {
              tenantId,
              placeId: body.placeId,
              hostUserId: auth.userId,
              categoryId: body.categoryId ?? null,
              title: body.title,
              description: body.description ?? null,
              status: body.status ?? "draft",
              priceMinor: body.priceMinor,
              currency: body.currency,
              attrs: body.attrs ?? {},
            });
          },
        );

        // FR-SRCH-002 / TR §18: same on-write embed contract as places.
        try {
          await embedRow(
            db,
            { tenantId, userId: auth.userId, role: auth.role },
            "experiences",
            experience.id,
            `${experience.title} ${experience.description ?? ""}`,
            embedder,
          );
        } catch (err) {
          request.log.warn(
            { err, experienceId: experience.id },
            "experience embedding failed; row left stale",
          );
        }

        return reply.status(201).send({
          data: { experience: toExperienceDto(experience) },
          meta: { requestId: request.requestId },
        });
      },
    );

    app.get(
      "/experiences",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          querystring: ListExperiencesQuery,
          response: {
            200: Type.Object({
              data: Type.Array(ExperienceDto),
              meta: PaginatedMeta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);
        const cursor =
          request.query.cursor !== undefined
            ? decodeCursor(request.query.cursor)
            : undefined;
        if (cursor && cursor.t === undefined) {
          throw new AppError("VALIDATION", 400, "Malformed cursor");
        }

        const { items, nextCursor } = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          (tx) =>
            listExperiences(tx, {
              limit: parseLimit(request.query.limit),
              ...(cursor ? { cursor } : {}),
            }),
        );

        return reply.send({
          data: items.map(toExperienceDto),
          meta: {
            requestId: request.requestId,
            pagination: { nextCursor },
          },
        });
      },
    );

    app.get(
      "/experiences/:id",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          params: IdParams,
          response: {
            200: Type.Object({
              data: Type.Object({ experience: ExperienceDto }),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);

        const experience = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          (tx) => getExperience(tx, request.params.id),
        );
        if (!experience) {
          throw new AppError("NOT_FOUND", 404, "Experience not found");
        }

        return reply.send({
          data: { experience: toExperienceDto(experience) },
          meta: { requestId: request.requestId },
        });
      },
    );

    app.get(
      "/experiences/:id/slots",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          params: IdParams,
          response: {
            200: Type.Object({
              data: Type.Array(SlotDto),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);

        // Slot visibility inherits the experience (RLS), so an invisible
        // experience simply yields an empty list.
        const slots = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          (tx) => listSlots(tx, request.params.id),
        );

        return reply.send({
          data: slots.map(toSlotDto),
          meta: { requestId: request.requestId },
        });
      },
    );

    app.post(
      "/experiences/:id/slots",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          params: IdParams,
          body: CreateSlotBody,
          response: {
            201: Type.Object({
              data: Type.Object({ slot: SlotDto }),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);
        const body = request.body;

        if (Date.parse(body.endsAt) <= Date.parse(body.startsAt)) {
          throw new AppError(
            "VALIDATION",
            400,
            "endsAt must be after startsAt",
          );
        }

        const slot = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (tx) => {
            const membership = await findMembership(tx, tenantId, auth.userId);
            if (
              !membership ||
              (membership.role !== "host" &&
                membership.role !== "tenant_admin")
            ) {
              throw new AppError(
                "FORBIDDEN",
                403,
                "Host or tenant admin access required",
              );
            }
            await tx`select set_config('app.role', ${membership.role}, true)`;

            const experience = await getExperience(tx, request.params.id);
            if (!experience) {
              throw new AppError("NOT_FOUND", 404, "Experience not found");
            }
            if (
              experience.host_user_id !== auth.userId &&
              membership.role !== "tenant_admin"
            ) {
              throw new AppError(
                "FORBIDDEN",
                403,
                "Only the experience host or a tenant admin can add slots",
              );
            }

            return createSlot(tx, {
              tenantId,
              experienceId: experience.id,
              startsAt: body.startsAt,
              endsAt: body.endsAt,
              capacity: body.capacity,
              status: body.status ?? "open",
            });
          },
        );

        return reply.status(201).send({
          data: { slot: toSlotDto(slot) },
          meta: { requestId: request.requestId },
        });
      },
    );

    // Bookings live under /experiences/:id/bookings (TRD §10.3); the top-level
    // /bookings routes are in bookings.routes.ts.
    app.post(
      "/experiences/:id/bookings",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          params: IdParams,
          headers: IdempotencyHeaders,
          body: CreateBookingBody,
          response: {
            201: Type.Object({
              data: Type.Object({ booking: BookingDto }),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);
        const body = request.body;
        const idempotencyKey = request.headers["idempotency-key"]!;
        const externalPaymentId = body.externalPaymentId ?? null;
        // FR-EXP-010: same key + same body replays; any difference conflicts.
        const requestHash = createHash("sha256")
          .update(
            JSON.stringify({
              e: request.params.id,
              s: body.slotId,
              p: body.partySize,
              x: externalPaymentId,
            }),
          )
          .digest("hex");

        const { booking } = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (tx) => {
            const membership = await findMembership(tx, tenantId, auth.userId);
            if (!membership) {
              throw new AppError(
                "FORBIDDEN",
                403,
                "Membership required to book",
              );
            }
            await tx`select set_config('app.role', ${membership.role}, true)`;

            return createBooking(tx, {
              tenantId,
              experienceId: request.params.id,
              slotId: body.slotId,
              userId: auth.userId,
              partySize: body.partySize,
              idempotencyKey,
              requestHash,
              externalPaymentId,
            });
          },
        );

        return reply.status(201).send({
          data: { booking: toBookingDto(booking) },
          meta: { requestId: request.requestId },
        });
      },
    );
  };

export default experiencesRoutes;
