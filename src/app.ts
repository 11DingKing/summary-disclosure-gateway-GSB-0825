import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import { PrismaClient } from "@prisma/client";
import { ApiError } from "./lib/errors";
import blocksRoutes from "./routes/blocks";
import publicationsRoutes from "./routes/publications";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
  prisma?: PrismaClient;
}

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Reject unknown body properties instead of silently stripping them:
    // forged provenance fields (e.g. client-supplied coveragePermille) must fail loudly.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const prisma = opts.prisma ?? new PrismaClient();
  app.decorate("prisma", prisma);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
    }
    if (typeof err === "object" && err !== null && "validation" in err) {
      const message =
        err instanceof Error ? err.message : "request validation failed";
      return reply
        .code(400)
        .send({ error: { code: "VALIDATION_ERROR", message } });
    }
    req.log.error(err);
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "internal server error" },
    });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Summary Disclosure Gateway",
        version: "1.0.0",
        description:
          "Provenance gate for reading products: SOURCE_EXCERPT / READER_NOTE / EDITOR_SUMMARY / AI_SUMMARY are strictly separated so derived content can never masquerade as original text. AI summaries must carry model provenance and citation spans; policy v1 requires coverage >= 700 permille with valid source hashes. Publications are immutable snapshots.",
      },
      tags: [
        {
          name: "blocks",
          description: "Content blocks of the four fixed kinds",
        },
        {
          name: "publications",
          description: "Immutable publication snapshots",
        },
        { name: "meta", description: "Gateway state" },
      ],
    },
  });

  app.get("/health", { schema: { hide: true } }, async () => ({
    status: "ok",
  }));

  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );

  app.get(
    "/meta",
    {
      schema: {
        tags: ["meta"],
        summary:
          "Current gateway revision (use as expectedRevision when publishing)",
      },
    },
    async () => {
      const state = await prisma.gatewayState.upsert({
        where: { id: 1 },
        create: { id: 1 },
        update: {},
      });
      return { revision: state.revision };
    },
  );

  await app.register(blocksRoutes);
  await app.register(publicationsRoutes);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}
