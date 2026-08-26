import type { FastifyInstance } from "fastify";
import { Prisma, type Block } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { sha256, stableStringify } from "../lib/hash";
import { computeCoveragePermille, spanInBounds } from "../lib/coverage";
import { encodeCursor, decodeCursor } from "../lib/cursor";
import { assessCitations, bumpRevision } from "../lib/policy";
import { BLOCK_KINDS, type CitationSpan } from "../lib/types";

interface CreateBlockBody {
  kind: string;
  text: string;
  version?: string;
  pageNumber?: number;
  modelProvider?: string;
  modelName?: string;
  generatedAt?: string;
  inputSourceBlockIds?: string[];
  citations?: CitationSpan[];
  idempotencyKey?: string;
}

interface PatchBlockBody {
  text?: string;
  version?: string;
  pageNumber?: number;
}

interface ListQuery {
  kind?: string;
  cursor?: string;
  limit?: number;
}

const citationSchema = {
  type: "object",
  required: ["start", "end", "sourceBlockId", "sourceHash"],
  additionalProperties: false,
  properties: {
    start: {
      type: "integer",
      minimum: 0,
      description: "code-point offset, inclusive",
    },
    end: {
      type: "integer",
      minimum: 0,
      description: "code-point offset, exclusive",
    },
    sourceBlockId: { type: "string" },
    sourceHash: {
      type: "string",
      description: "sha256 hex of the source block text at citation time",
    },
  },
} as const;

const createBodySchema = {
  type: "object",
  required: ["kind", "text"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...BLOCK_KINDS] },
    text: { type: "string", minLength: 1 },
    version: { type: "string", description: "required for SOURCE_EXCERPT" },
    pageNumber: {
      type: "integer",
      minimum: 1,
      description: "required for SOURCE_EXCERPT",
    },
    modelProvider: { type: "string", description: "required for AI_SUMMARY" },
    modelName: { type: "string", description: "required for AI_SUMMARY" },
    generatedAt: {
      type: "string",
      description: "ISO 8601, required for AI_SUMMARY",
    },
    inputSourceBlockIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "required for AI_SUMMARY",
    },
    citations: {
      type: "array",
      minItems: 1,
      items: citationSchema,
      description: "required for AI_SUMMARY",
    },
    idempotencyKey: { type: "string" },
  },
} as const;

export function serializeBlock(b: Block) {
  return {
    id: b.id,
    kind: b.kind,
    text: b.text,
    version: b.version,
    pageNumber: b.pageNumber,
    modelProvider: b.modelProvider,
    modelName: b.modelName,
    generatedAt: b.generatedAt ? b.generatedAt.toISOString() : null,
    inputSourceBlockIds: b.inputSourceBlockIds
      ? (JSON.parse(b.inputSourceBlockIds) as string[])
      : null,
    citations: b.citations ? (JSON.parse(b.citations) as CitationSpan[]) : null,
    contentHash: b.contentHash,
    coveragePermille: b.coveragePermille,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

function idempotencyKeyOf(
  headerValue: string | string[] | undefined,
  bodyKey?: string,
): string | undefined {
  const fromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return fromHeader ?? bodyKey;
}

export default async function blocksRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateBlockBody }>(
    "/blocks",
    {
      schema: {
        tags: ["blocks"],
        summary: "Create a content block (idempotent)",
        description:
          "kind-specific rules: SOURCE_EXCERPT requires version+pageNumber; AI_SUMMARY requires modelProvider, modelName, generatedAt, inputSourceBlockIds and per-citation CitationSpans. coveragePermille is always computed by the server.",
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string" } },
        },
        body: createBodySchema,
      },
    },
    async (req, reply) => {
      const body = req.body;

      if (body.kind === "SOURCE_EXCERPT") {
        const missing: string[] = [];
        if (body.version === undefined) missing.push("version");
        if (body.pageNumber === undefined) missing.push("pageNumber");
        if (missing.length > 0) {
          throw new ApiError(
            400,
            "MISSING_REQUIRED_FIELDS",
            "SOURCE_EXCERPT requires version and pageNumber",
            {
              kind: body.kind,
              fields: missing,
            },
          );
        }
      }

      let aiCoveragePermille: number | null = null;
      if (body.kind === "AI_SUMMARY") {
        const missing: string[] = [];
        if (!body.modelProvider) missing.push("modelProvider");
        if (!body.modelName) missing.push("modelName");
        if (!body.generatedAt) missing.push("generatedAt");
        if (!body.inputSourceBlockIds || body.inputSourceBlockIds.length === 0)
          missing.push("inputSourceBlockIds");
        if (!body.citations || body.citations.length === 0)
          missing.push("citations");
        if (missing.length > 0) {
          throw new ApiError(
            400,
            "MISSING_REQUIRED_FIELDS",
            "AI_SUMMARY requires full provenance",
            {
              kind: body.kind,
              fields: missing,
            },
          );
        }
        if (Number.isNaN(Date.parse(body.generatedAt!))) {
          throw new ApiError(
            400,
            "INVALID_GENERATED_AT",
            "generatedAt must be an ISO 8601 timestamp",
          );
        }
        const textLength = Array.from(body.text).length;
        body.citations!.forEach((c, i) => {
          if (!spanInBounds(c, body.text)) {
            throw new ApiError(
              400,
              "INVALID_CITATION_SPAN",
              "citation span out of bounds",
              {
                citationIndex: i,
                textLength,
              },
            );
          }
          if (!body.inputSourceBlockIds!.includes(c.sourceBlockId)) {
            throw new ApiError(
              400,
              "CITATION_SOURCE_NOT_LISTED",
              "citation sourceBlockId must be listed in inputSourceBlockIds",
              {
                citationIndex: i,
                sourceBlockId: c.sourceBlockId,
              },
            );
          }
        });
        const sources = await app.prisma.block.findMany({
          where: { id: { in: body.inputSourceBlockIds } },
          select: { id: true, contentHash: true },
        });
        const sourcesById = new Map(sources.map((s) => [s.id, s]));
        const unknown = body.inputSourceBlockIds!.filter(
          (id) => !sourcesById.has(id),
        );
        if (unknown.length > 0) {
          throw new ApiError(
            400,
            "UNKNOWN_SOURCE_BLOCK",
            "input source blocks do not exist",
            { sourceBlockIds: unknown },
          );
        }
        // Server-side coverage: only spans whose recorded hash still matches count.
        const { validSpans } = assessCitations(
          body.text,
          body.citations!,
          sourcesById,
        );
        aiCoveragePermille = computeCoveragePermille(body.text, validSpans);
      }

      const idempotencyKey = idempotencyKeyOf(
        req.headers["idempotency-key"],
        body.idempotencyKey,
      );
      const requestHash = sha256(
        stableStringify({ ...body, idempotencyKey: undefined }),
      );
      if (idempotencyKey) {
        const existing = await app.prisma.block.findUnique({
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
          return reply.code(200).send(serializeBlock(existing));
        }
      }

      let created: Block;
      try {
        created = await app.prisma.$transaction(async (tx) => {
          await bumpRevision(tx);
          return tx.block.create({
            data: {
              kind: body.kind,
              text: body.text,
              version: body.kind === "SOURCE_EXCERPT" ? body.version : null,
              pageNumber:
                body.kind === "SOURCE_EXCERPT" ? body.pageNumber : null,
              modelProvider:
                body.kind === "AI_SUMMARY" ? body.modelProvider : null,
              modelName: body.kind === "AI_SUMMARY" ? body.modelName : null,
              generatedAt:
                body.kind === "AI_SUMMARY" ? new Date(body.generatedAt!) : null,
              inputSourceBlockIds:
                body.kind === "AI_SUMMARY"
                  ? JSON.stringify(body.inputSourceBlockIds)
                  : null,
              citations:
                body.kind === "AI_SUMMARY"
                  ? JSON.stringify(body.citations)
                  : null,
              coveragePermille: aiCoveragePermille,
              contentHash: sha256(body.text),
              idempotencyKey: idempotencyKey ?? null,
              requestHash: idempotencyKey ? requestHash : null,
            },
          });
        });
      } catch (err) {
        // Lost a race on the idempotency key: return the winner.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002" &&
          idempotencyKey
        ) {
          const existing = await app.prisma.block.findUnique({
            where: { idempotencyKey },
          });
          if (existing) return reply.code(200).send(serializeBlock(existing));
        }
        throw err;
      }
      return reply.code(201).send(serializeBlock(created));
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/blocks",
    {
      schema: {
        tags: ["blocks"],
        summary: "List blocks (cursor pagination, stable createdAt,id order)",
        querystring: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...BLOCK_KINDS] },
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const { kind, cursor } = req.query;
      const limit = req.query.limit ?? 20;

      const where: Prisma.BlockWhereInput = {};
      if (kind) where.kind = kind;
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (!decoded)
          throw new ApiError(400, "INVALID_CURSOR", "cursor is malformed");
        where.OR = [
          { createdAt: { gt: decoded.createdAt } },
          { createdAt: decoded.createdAt, id: { gt: decoded.id } },
        ];
      }

      const rows = await app.prisma.block.findMany({
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
      return reply.send({ items: items.map(serializeBlock), nextCursor });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/blocks/:id",
    { schema: { tags: ["blocks"], summary: "Get a block by id" } },
    async (req, reply) => {
      const block = await app.prisma.block.findUnique({
        where: { id: req.params.id },
      });
      if (!block)
        throw new ApiError(404, "BLOCK_NOT_FOUND", "block not found", {
          id: req.params.id,
        });
      return reply.send(serializeBlock(block));
    },
  );

  app.patch<{ Params: { id: string }; Body: PatchBlockBody }>(
    "/blocks/:id",
    {
      schema: {
        tags: ["blocks"],
        summary:
          "Update a block text / excerpt metadata (bumps revision, may invalidate citations)",
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1 },
            version: { type: "string" },
            pageNumber: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const block = await app.prisma.block.findUnique({
        where: { id: req.params.id },
      });
      if (!block)
        throw new ApiError(404, "BLOCK_NOT_FOUND", "block not found", {
          id: req.params.id,
        });

      if (
        (body.version !== undefined || body.pageNumber !== undefined) &&
        block.kind !== "SOURCE_EXCERPT"
      ) {
        throw new ApiError(
          400,
          "FIELD_NOT_ALLOWED",
          "version/pageNumber apply only to SOURCE_EXCERPT",
          { kind: block.kind },
        );
      }

      const newText = body.text ?? block.text;
      let coveragePermille = block.coveragePermille;
      if (
        block.kind === "AI_SUMMARY" &&
        body.text !== undefined &&
        block.citations
      ) {
        const citations = JSON.parse(block.citations) as CitationSpan[];
        const sourceIds = citations.map((c) => c.sourceBlockId);
        const sources = await app.prisma.block.findMany({
          where: { id: { in: sourceIds } },
          select: { id: true, contentHash: true },
        });
        const { validSpans } = assessCitations(
          newText,
          citations,
          new Map(sources.map((s) => [s.id, s])),
        );
        coveragePermille = computeCoveragePermille(newText, validSpans);
      }

      const updated = await app.prisma.$transaction(async (tx) => {
        await bumpRevision(tx);
        return tx.block.update({
          where: { id: block.id },
          data: {
            text: newText,
            contentHash: sha256(newText),
            version: body.version ?? block.version,
            pageNumber: body.pageNumber ?? block.pageNumber,
            coveragePermille,
          },
        });
      });
      return reply.send(serializeBlock(updated));
    },
  );
}
