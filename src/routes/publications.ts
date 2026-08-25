import type { PrismaClient } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { notFound } from "../errors.js";
import {
  InvalidCursorError,
  encodeCursor,
  resolvePageParams,
} from "../lib/pagination.js";
import { serializePublication } from "../lib/serialize.js";
import { badRequest } from "../errors.js";
import {
  errorResponseSchema,
  listPublicationsResponseSchema,
  publicationDtoSchema,
  publicationListQuerySchema,
} from "../validation/schemas.js";

export function publicationsRoutes(prisma: PrismaClient): FastifyPluginAsync {
  return async (app) => {
    app.get(
      "/v1/publications",
      {
        schema: {
          tags: ["publications"],
          summary: "List publications (cursor-paginated, immutable snapshots)",
          querystring: publicationListQuerySchema,
          response: {
            200: listPublicationsResponseSchema,
          },
        },
      },
      async (request) => {
        const query = request.query as { limit?: string; cursor?: string };
        let page;
        try {
          page = resolvePageParams(
            query.limit,
            query.cursor,
            config.pagination.defaultPageSize,
            config.pagination.maxPageSize,
          );
        } catch (err) {
          if (err instanceof InvalidCursorError) {
            throw badRequest("INVALID_CURSOR", err.message);
          }
          throw err;
        }

        const cursorWhere = page.cursor
          ? {
              OR: [
                { publishedAt: { gt: new Date(page.cursor.createdAt) } },
                {
                  publishedAt: new Date(page.cursor.createdAt),
                  id: { gt: page.cursor.id },
                },
              ],
            }
          : {};

        const rows = await prisma.publication.findMany({
          where: cursorWhere,
          orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
          take: page.limit + 1,
        });

        const hasMore = rows.length > page.limit;
        const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
        const items = pageRows.map(serializePublication);

        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeCursor({
                createdAt: last.publishedAt.toISOString(),
                id: last.id,
              })
            : null;

        return { items, nextCursor };
      },
    );

    app.get(
      "/v1/publications/:id",
      {
        schema: {
          tags: ["publications"],
          summary: "Get a publication snapshot by id",
          response: {
            200: publicationDtoSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params as { id: string };
        const publication = await prisma.publication.findUnique({
          where: { id },
        });
        if (!publication) {
          throw notFound(
            "PUBLICATION_NOT_FOUND",
            `Publication ${id} not found.`,
          );
        }
        return serializePublication(publication);
      },
    );
  };
}
