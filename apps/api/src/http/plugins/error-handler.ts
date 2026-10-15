import type { FastifyError, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { AppError } from "../../lib/errors.js";

function isValidationError(error: unknown): error is FastifyError {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    (error as FastifyError).validation !== undefined
  );
}

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.requestId ?? "unknown";

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
        meta: { requestId },
      });
    }

    if (isValidationError(error)) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION",
          message: "Request validation failed",
          details: error.validation,
        },
        meta: { requestId },
      });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: "Internal server error",
      },
      meta: { requestId },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
      },
      meta: { requestId: request.requestId ?? "unknown" },
    });
  });
};

export default fp(errorHandlerPlugin, { name: "error-handler" });
