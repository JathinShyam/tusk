import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Db } from "../../db/client.js";
import { withRls } from "../../db/tx.js";
import { activeTenantId, authOf } from "../../http/plugins/auth.js";
import { decodeCursor } from "../../lib/cursor.js";
import { Meta, PaginatedMeta } from "../../lib/envelope.js";
import { AppError } from "../../lib/errors.js";
import { BookingDto } from "./dto.js";
import {
  cancelBooking,
  getBooking,
  listBookings,
  toBookingDto,
} from "./bookings.service.js";

type BookingRoutesOpts = { db: Db };

const IdParams = Type.Object({ id: Type.String({ format: "uuid" }) });

const ListBookingsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});

export const bookingsRoutes: FastifyPluginAsyncTypebox<BookingRoutesOpts> =
  async (app, opts) => {
    const { db } = opts;

    // FR-EXP-012: RLS decides the set — explorer sees own, host sees bookings
    // on their experiences, tenant admin sees the tenant.
    app.get(
      "/bookings",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          querystring: ListBookingsQuery,
          response: {
            200: Type.Object({
              data: Type.Array(BookingDto),
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
            listBookings(tx, {
              limit: request.query.limit ?? 20,
              ...(cursor ? { cursor } : {}),
            }),
        );

        return reply.send({
          data: items.map(toBookingDto),
          meta: {
            requestId: request.requestId,
            pagination: { nextCursor },
          },
        });
      },
    );

    app.get(
      "/bookings/:id",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          params: IdParams,
          response: {
            200: Type.Object({
              data: Type.Object({ booking: BookingDto }),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);

        const booking = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          (tx) => getBooking(tx, request.params.id),
        );
        if (!booking) {
          throw new AppError("NOT_FOUND", 404, "Booking not found");
        }

        return reply.send({
          data: { booking: toBookingDto(booking) },
          meta: { requestId: request.requestId },
        });
      },
    );

    app.post(
      "/bookings/:id/cancel",
      {
        preHandler: app.requireTenantAuth,
        schema: {
          params: IdParams,
          response: {
            200: Type.Object({
              data: Type.Object({ booking: BookingDto }),
              meta: Meta,
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const tenantId = activeTenantId(request);

        const booking = await withRls(
          db,
          { tenantId, userId: auth.userId, role: auth.role },
          async (tx) => {
            // SELECT is the visibility check (404); the UPDATE policy has the
            // same predicate, so a visible booking is cancellable.
            const found = await getBooking(tx, request.params.id);
            if (!found) {
              throw new AppError("NOT_FOUND", 404, "Booking not found");
            }
            const cancelled = await cancelBooking(tx, request.params.id);
            if (!cancelled) {
              throw new AppError(
                "FORBIDDEN",
                403,
                "You cannot cancel this booking",
              );
            }
            return cancelled;
          },
        );

        return reply.send({
          data: { booking: toBookingDto(booking) },
          meta: { requestId: request.requestId },
        });
      },
    );
  };

export default bookingsRoutes;
