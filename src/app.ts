import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { submissionsRoutes } from "./routes/submissions.js";
import { publicationsRoutes } from "./routes/publications.js";

export async function buildApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== "test",
    trustProxy: true,
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }

    if (err.validation) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: err.message,
          details: err.validation,
        },
      });
    }

    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Resource not found." },
      });
    }

    request.log.error(err);
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message:
          config.nodeEnv === "production"
            ? "Internal server error."
            : err.message,
      },
    });
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Summary Disclosure Gateway",
        version: "1.0.0",
        description:
          "A source-attribution gateway that keeps original source excerpts, reader notes, editor summaries and AI-generated summaries unmistakably distinct. Enforces citation coverage and source-hash validity before publication, and stores immutable publication snapshots.",
      },
      servers: [{ url: "/" }],
      tags: [
        {
          name: "submissions",
          description: "Create and inspect submissions of all four kinds.",
        },
        {
          name: "publications",
          description: "Publish and retrieve immutable snapshots.",
        },
      ],
      components: {
        securitySchemes: {},
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(submissionsRoutes(prisma));
  await app.register(publicationsRoutes(prisma));

  await app.ready();
  return app;
}
