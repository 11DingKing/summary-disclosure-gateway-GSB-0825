import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { openapiDocument } from './openapi.js';
import submissionsRoutes from './routes/submissions.js';
import publicationsRoutes from './routes/publications.js';

export async function buildApp(db?: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
  });

  const client =
    db ??
    new PrismaClient({
      datasources: { db: { url: config.databaseUrl } },
    });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ?? {}),
        },
      });
      return;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Resource not found' },
        });
        return;
      }
      if (error.code === 'P2002') {
        reply.code(409).send({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'The request conflicts with existing state',
            target: error.meta?.target ?? null,
          },
        });
        return;
      }
    }

    if (typeof (error as { statusCode?: number }).statusCode === 'number') {
      const statusCode = (error as { statusCode: number }).statusCode;
      if (statusCode >= 400 && statusCode < 500) {
        reply.code(statusCode).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: error instanceof Error ? error.message : 'Invalid request',
          },
        });
        return;
      }
    }

    request.log.error({ err: error }, 'Unhandled error');
    reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  await app.register(
    swagger,
    {
      mode: 'static',
      specification: { document: openapiDocument },
      specificationPrefix: '/docs',
    } as never,
  );

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/v1/openapi.json', async () => openapiDocument);

  await app.register(submissionsRoutes, { db: client, prefix: '/v1' });
  await app.register(publicationsRoutes, { db: client, prefix: '/v1' });

  return app;
}
