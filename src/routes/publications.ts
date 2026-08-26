import type { FastifyInstance } from "fastify";
import { Prisma, type Publication, type Block } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { sha256, stableStringify } from "../lib/hash";
import { encodeCursor, decodeCursor } from "../lib/cursor";
import { Mutex } from "../lib/mutex";
import {
  evaluatePolicyV1,
  SUPPORTED_POLICY_VERSIONS,
  POLICY_V1,
} from "../lib/policy";
import type { CitationSpan } from "../lib/types";
import { serializeBlock } from "./blocks";

interface CreatePublicationBody {
  summaryBlockId: string;
  policyVersion: string;
  expectedRevision: number;
  idempotencyKey?: string;
}

interface ListQuery {
  cursor?: string;
  limit?: number;
}

const publishMutex = new Mutex();

function buildSnapshot(
  summary: Block,
  sources: Block[],
  policyVersion: string,
  revision: number,
) {
  return {
    policyVersion,
    revision,
    publishedAt: new Date().toISOString(),
    summary: serializeBlock(summary),
    sources: sources.map(serializeBlock),
  };
}

function serializePublicationMeta(p: Publication) {
  return {
    id: p.id,
    summaryBlockId: p.summaryBlockId,
    policyVersion: p.policyVersion,
    revision: p.revision,
    coveragePermille: p.coveragePermille,
    createdAt: p.createdAt.toISOString(),
  };
}

function serializePublication(p: Publication) {
  return {
    ...serializePublicationMeta(p),
    snapshot: JSON.parse(p.snapshot) as unknown,
  };
}

export default async function publicationsRoutes(app: FastifyInstance) {
  app.post<{ Body: CreatePublicationBody }>(
    "/publications",
    {
      schema: {
        tags: ["publications"],
        summary:
          "Publish an AI_SUMMARY under a policy (idempotent, optimistic concurrency)",
        description:
          "Policy v1: coveragePermille >= 700 and every cited source hash still valid. On success an immutable Publication snapshot is created; later source edits never rewrite it. expectedRevision must equal the current gateway revision (see GET /meta). Rejections return HTTP 422 with machine-readable reasons.",
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string" } },
        },
        body: {
          type: "object",
          required: ["summaryBlockId", "policyVersion", "expectedRevision"],
          additionalProperties: false,
          properties: {
            summaryBlockId: { type: "string" },
            policyVersion: {
              type: "string",
              enum: [...SUPPORTED_POLICY_VERSIONS, "v2", "v3"],
            },
            expectedRevision: { type: "integer", minimum: 0 },
            idempotencyKey: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body;

      if (
        !SUPPORTED_POLICY_VERSIONS.includes(
          body.policyVersion as typeof POLICY_V1,
        )
      ) {
        throw new ApiError(
          400,
          "UNSUPPORTED_POLICY_VERSION",
          "unsupported policyVersion",
          {
            supported: SUPPORTED_POLICY_VERSIONS,
          },
        );
      }

      const idempotencyKey =
        (Array.isArray(req.headers["idempotency-key"])
          ? req.headers["idempotency-key"][0]
          : req.headers["idempotency-key"]) ?? body.idempotencyKey;
      const requestHash = sha256(
        stableStringify({ ...body, idempotencyKey: undefined }),
      );
      if (idempotencyKey) {
        const existing = await app.prisma.publication.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_KEY_CONFLICT",
              "idempotency key reused with a different payload",
            );
          }
          return reply.code(200).send(serializePublication(existing));
        }
      }

      const summary = await app.prisma.block.findUnique({
        where: { id: body.summaryBlockId },
      });
      if (!summary)
        throw new ApiError(404, "BLOCK_NOT_FOUND", "summary block not found", {
          id: body.summaryBlockId,
        });
      if (summary.kind !== "AI_SUMMARY") {
        throw new ApiError(
          400,
          "INVALID_SUMMARY_KIND",
          "only AI_SUMMARY blocks can be published under policy v1",
          {
            kind: summary.kind,
          },
        );
      }

      const publication = await publishMutex.run(() =>
        app.prisma.$transaction(async (tx) => {
          // Optimistic concurrency: claim the next revision only if it matches.
          const claimed = await tx.gatewayState.updateMany({
            where: { id: 1, revision: body.expectedRevision },
            data: { revision: { increment: 1 } },
          });
          if (claimed.count === 0) {
            const current = await tx.gatewayState.findUnique({
              where: { id: 1 },
            });
            throw new ApiError(
              409,
              "REVISION_MISMATCH",
              "expectedRevision does not match current revision",
              {
                expected: body.expectedRevision,
                current: current?.revision ?? 0,
              },
            );
          }

          const citations = JSON.parse(summary.citations!) as CitationSpan[];
          const inputIds = JSON.parse(summary.inputSourceBlockIds!) as string[];
          const allSourceIds = [
            ...new Set([...inputIds, ...citations.map((c) => c.sourceBlockId)]),
          ];
          const sources = await tx.block.findMany({
            where: { id: { in: allSourceIds } },
          });
          const sourcesById = new Map(sources.map((s) => [s.id, s]));

          const { coveragePermille, reasons } = evaluatePolicyV1(
            summary.text,
            citations,
            sourcesById,
          );
          if (reasons.length > 0) {
            throw new ApiError(
              422,
              "POLICY_REJECTION",
              "publication rejected by policy",
              {
                policyVersion: POLICY_V1,
                reasons,
              },
            );
          }

          const snapshot = buildSnapshot(
            summary,
            sources,
            POLICY_V1,
            body.expectedRevision,
          );
          return tx.publication.create({
            data: {
              summaryBlockId: summary.id,
              policyVersion: POLICY_V1,
              revision: body.expectedRevision,
              coveragePermille,
              snapshot: JSON.stringify(snapshot),
              idempotencyKey: idempotencyKey ?? null,
              requestHash: idempotencyKey ? requestHash : null,
            },
          });
        }),
      );

      return reply.code(201).send(serializePublication(publication));
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/publications",
    {
      schema: {
        tags: ["publications"],
        summary:
          "List publications (cursor pagination, stable createdAt,id order)",
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const limit = req.query.limit ?? 20;
      const where: Prisma.PublicationWhereInput = {};
      if (req.query.cursor) {
        const decoded = decodeCursor(req.query.cursor);
        if (!decoded)
          throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
        where.OR = [
          { createdAt: { gt: decoded.createdAt } },
          { createdAt: decoded.createdAt, id: { gt: decoded.id } },
        ];
      }
      const rows = await app.prisma.publication.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null;
      return reply.send({
        items: items.map(serializePublicationMeta),
        nextCursor,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/publications/:id",
    {
      schema: {
        tags: ["publications"],
        summary: "Get a publication with its immutable snapshot",
        description:
          "The snapshot is returned verbatim; later edits to source blocks never rewrite it.",
      },
    },
    async (req, reply) => {
      const publication = await app.prisma.publication.findUnique({
        where: { id: req.params.id },
      });
      if (!publication)
        throw new ApiError(
          404,
          "PUBLICATION_NOT_FOUND",
          "publication not found",
          { id: req.params.id },
        );
      return reply.send(serializePublication(publication));
    },
  );
}
