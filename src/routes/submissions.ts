import {
  Prisma,
  type PrismaClient,
  type Submission as SubmissionModel,
  type CitationSpan as CitationSpanModel,
} from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import {
  AI_SUMMARY,
  EDITOR_SUMMARY,
  READER_NOTE,
  SOURCE_EXCERPT,
  type Kind,
} from "../constants.js";
import { config } from "../config.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { idempotentCreate } from "../lib/idempotency.js";
import { computeContentHash } from "../lib/hash.js";
import {
  InvalidCursorError,
  encodeCursor,
  resolvePageParams,
} from "../lib/pagination.js";
import { evaluatePolicy } from "../lib/policy.js";
import {
  attachCoverage,
  buildSnapshot,
  coverageForSubmission,
  loadSourceBlocksMap,
  serializePublication,
  serializeSubmission,
} from "../lib/serialize.js";
import { codePointLength } from "../lib/unicode.js";
import type {
  CreateSubmissionBody,
  PublishBody,
  SubmissionDto,
  UpdateSubmissionBody,
} from "../types.js";
import {
  createSubmissionBodySchema,
  errorResponseSchema,
  idempotencyHeaderSchema,
  listQuerySchema,
  listSubmissionsResponseSchema,
  publicationDtoSchema,
  publishBodySchema,
  submissionDtoSchema,
  updateSubmissionBodySchema,
} from "../validation/schemas.js";

const SUBMISSIONS_ENDPOINT = "POST /v1/submissions";
const PUBLISH_ENDPOINT = "POST /v1/submissions/:id/publish";

export function submissionsRoutes(prisma: PrismaClient): FastifyPluginAsync {
  return async (app) => {
    app.post(
      "/v1/submissions",
      {
        schema: {
          tags: ["submissions"],
          summary: "Create a submission of any kind",
          description:
            "Creates a SOURCE_EXCERPT, READER_NOTE, EDITOR_SUMMARY or AI_SUMMARY. Supports the Idempotency-Key header.",
          headers: idempotencyHeaderSchema,
          body: createSubmissionBodySchema,
          response: {
            201: submissionDtoSchema,
            400: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const body = request.body as CreateSubmissionBody;
        const idempotencyKey = pickIdempotencyKey(request.headers);

        const { response, replayed } = await idempotentCreate<SubmissionDto>(
          prisma,
          idempotencyKey,
          SUBMISSIONS_ENDPOINT,
          async (tx) => {
            const created = await createSubmission(tx, body);
            const dto = await serializeAfterCreate(
              tx,
              created.submission,
              created.citations,
            );
            return { id: created.submission.id, response: dto };
          },
        );

        return reply.code(replayed ? 200 : 201).send(response);
      },
    );

    app.get(
      "/v1/submissions",
      {
        schema: {
          tags: ["submissions"],
          summary: "List submissions (cursor-paginated)",
          querystring: listQuerySchema,
          response: {
            200: listSubmissionsResponseSchema,
          },
        },
      },
      async (request) => {
        const query = request.query as {
          limit?: string;
          cursor?: string;
          kind?: string;
        };
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

        const where: Prisma.SubmissionWhereInput = {};
        if (query.kind) where.kind = query.kind;

        const orderBy: Prisma.SubmissionOrderByWithRelationInput[] = [
          { createdAt: "asc" },
          { id: "asc" },
        ];

        const cursorWhere: Prisma.SubmissionWhereInput = page.cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(page.cursor.createdAt) } },
                {
                  createdAt: new Date(page.cursor.createdAt),
                  id: { gt: page.cursor.id },
                },
              ],
            }
          : {};

        const rows = await prisma.submission.findMany({
          where: { AND: [where, cursorWhere] },
          orderBy,
          take: page.limit + 1,
          include: { citationsOut: true },
        });

        const hasMore = rows.length > page.limit;
        const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

        const coverage = await attachCoverage(
          prisma,
          pageRows.map((r) => ({
            submission: r,
            citations: r.citationsOut,
          })),
        );

        const items = pageRows.map((r) =>
          serializeSubmission(
            r,
            r.citationsOut,
            coverage.get(r.id)?.coveragePermille,
          ),
        );

        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeCursor({
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              })
            : null;

        return { items, nextCursor };
      },
    );

    app.get(
      "/v1/submissions/:id",
      {
        schema: {
          tags: ["submissions"],
          summary: "Get a submission by id",
          response: {
            200: submissionDtoSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params as { id: string };
        const submission = await prisma.submission.findUnique({
          where: { id },
          include: { citationsOut: true },
        });
        if (!submission) {
          throw notFound("SUBMISSION_NOT_FOUND", `Submission ${id} not found.`);
        }
        let coveragePermille: number | undefined;
        if (submission.kind === AI_SUMMARY) {
          const sourceIds = Array.from(
            new Set(submission.citationsOut.map((c) => c.sourceBlockId)),
          );
          const sourceBlocks = await loadSourceBlocksMap(prisma, sourceIds);
          coveragePermille = coverageForSubmission(
            submission,
            submission.citationsOut,
            sourceBlocks,
          ).coveragePermille;
        }
        return serializeSubmission(
          submission,
          submission.citationsOut,
          coveragePermille,
        );
      },
    );

    app.patch(
      "/v1/submissions/:id",
      {
        schema: {
          tags: ["submissions"],
          summary: "Update a source excerpt content",
          description:
            "Only SOURCE_EXCERPT submissions may be edited. Editing changes the content hash and bumps the revision, which invalidates any outstanding AI citations that referenced the prior hash.",
          body: updateSubmissionBodySchema,
          response: {
            200: submissionDtoSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params as { id: string };
        const body = request.body as UpdateSubmissionBody;

        const existing = await prisma.submission.findUnique({
          where: { id },
        });
        if (!existing) {
          throw notFound("SUBMISSION_NOT_FOUND", `Submission ${id} not found.`);
        }
        if (existing.kind !== SOURCE_EXCERPT) {
          throw conflict(
            "IMMUTABLE_SUBMISSION",
            `Only ${SOURCE_EXCERPT} submissions can be edited.`,
          );
        }

        if (body.content === existing.content) {
          return serializeSubmission(existing);
        }

        const updated = await prisma.submission.update({
          where: { id },
          data: {
            content: body.content,
            contentHash: computeContentHash(body.content),
            revision: { increment: 1 },
          },
        });
        return serializeSubmission(updated);
      },
    );

    app.post(
      "/v1/submissions/:id/publish",
      {
        schema: {
          tags: ["publications"],
          summary: "Publish an immutable snapshot of a submission",
          headers: idempotencyHeaderSchema,
          body: publishBodySchema,
          response: {
            201: publicationDtoSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as PublishBody;
        const idempotencyKey = pickIdempotencyKey(request.headers);

        const submission = await prisma.submission.findUnique({
          where: { id },
          include: { citationsOut: true },
        });
        if (!submission) {
          throw notFound("SUBMISSION_NOT_FOUND", `Submission ${id} not found.`);
        }

        if (submission.revision !== body.expectedRevision) {
          throw conflict(
            "REVISION_MISMATCH",
            `Expected revision ${body.expectedRevision} but submission is at revision ${submission.revision}.`,
            {
              expectedRevision: body.expectedRevision,
              currentRevision: submission.revision,
            },
          );
        }

        const sourceIds = Array.from(
          new Set(submission.citationsOut.map((c) => c.sourceBlockId)),
        );
        const sourceBlocks = await loadSourceBlocksMap(prisma, sourceIds);
        const coverage = coverageForSubmission(
          submission,
          submission.citationsOut,
          sourceBlocks,
        );

        const decision = evaluatePolicy(body.policyVersion, {
          kind: submission.kind as Kind,
          coveragePermille: coverage.coveragePermille,
          invalidCitations: coverage.invalidCitations,
        });

        if (!decision.allowed) {
          throw unprocessable(
            "POLICY_VIOLATION",
            "Publication rejected by policy.",
            {
              policyVersion: body.policyVersion,
              rejections: decision.rejections,
              coveragePermille: coverage.coveragePermille,
            },
          );
        }

        const publishedAt = new Date();
        const snapshot = buildSnapshot(
          submission,
          submission.citationsOut,
          sourceBlocks,
          coverage,
          body.policyVersion,
          publishedAt,
        );

        const { response, replayed } = await idempotentCreate(
          prisma,
          idempotencyKey,
          PUBLISH_ENDPOINT,
          async (tx) => {
            try {
              const publication = await tx.publication.create({
                data: {
                  submissionId: submission.id,
                  policyVersion: body.policyVersion,
                  revision: submission.revision,
                  coveragePermille: coverage.coveragePermille,
                  sourceHashesValid: coverage.invalidCitations.length === 0,
                  snapshot: JSON.stringify(snapshot),
                  publishedAt,
                },
              });
              return {
                id: publication.id,
                response: serializePublication(publication),
              };
            } catch (err) {
              if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2002"
              ) {
                const target = err.meta?.target;
                if (
                  Array.isArray(target) &&
                  target.includes("submissionId") &&
                  target.includes("revision")
                ) {
                  throw conflict(
                    "ALREADY_PUBLISHED",
                    `Submission ${submission.id} revision ${submission.revision} has already been published.`,
                    {
                      submissionId: submission.id,
                      revision: submission.revision,
                    },
                  );
                }
              }
              throw err;
            }
          },
        );

        return reply.code(replayed ? 200 : 201).send(response);
      },
    );
  };
}

function pickIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers["idempotency-key"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function createSubmission(
  tx: Prisma.TransactionClient,
  body: CreateSubmissionBody,
): Promise<{ submission: SubmissionModel; citations: CitationSpanModel[] }> {
  if (body.kind === SOURCE_EXCERPT) {
    const submission = await tx.submission.create({
      data: {
        kind: SOURCE_EXCERPT,
        content: body.content,
        version: body.version,
        page: body.page,
        contentHash: computeContentHash(body.content),
      },
    });
    return { submission, citations: [] };
  }

  if (body.kind === READER_NOTE || body.kind === EDITOR_SUMMARY) {
    const submission = await tx.submission.create({
      data: {
        kind: body.kind,
        content: body.content,
      },
    });
    return { submission, citations: [] };
  }

  return createAiSummary(tx, body);
}

async function createAiSummary(
  tx: Prisma.TransactionClient,
  body: CreateSubmissionBody,
): Promise<{ submission: SubmissionModel; citations: CitationSpanModel[] }> {
  const generatedAt = new Date(body.generatedAt as string);
  if (Number.isNaN(generatedAt.getTime())) {
    throw badRequest(
      "INVALID_GENERATED_AT",
      "generatedAt must be a valid ISO-8601 date-time.",
    );
  }

  const inputIds = Array.from(new Set(body.inputSourceBlockIds as string[]));
  const sourceBlocks = await loadSourceBlocksMap(tx, inputIds);

  for (const id of inputIds) {
    const block = sourceBlocks.get(id);
    if (!block) {
      throw badRequest(
        "SOURCE_BLOCK_NOT_FOUND",
        `Input source block ${id} does not exist.`,
        { sourceBlockId: id },
      );
    }
    if (block.kind !== SOURCE_EXCERPT) {
      throw badRequest(
        "SOURCE_BLOCK_KIND_MISMATCH",
        `Input source block ${id} is not a ${SOURCE_EXCERPT}.`,
        { sourceBlockId: id, kind: block.kind },
      );
    }
  }

  const length = codePointLength(body.content);
  const citationInputs = body.citations ?? [];
  for (const c of citationInputs) {
    if (!inputIds.includes(c.sourceBlockId)) {
      throw badRequest(
        "CITATION_SOURCE_NOT_IN_INPUT",
        `Citation source block ${c.sourceBlockId} is not listed in inputSourceBlockIds.`,
        { sourceBlockId: c.sourceBlockId },
      );
    }
    if (
      !Number.isInteger(c.startOffset) ||
      !Number.isInteger(c.endOffset) ||
      c.startOffset < 0 ||
      c.endOffset > length ||
      c.startOffset >= c.endOffset
    ) {
      throw badRequest(
        "CITATION_OFFSET_OUT_OF_BOUNDS",
        `Citation offsets [${c.startOffset}, ${c.endOffset}) are invalid for content length ${length}.`,
        { startOffset: c.startOffset, endOffset: c.endOffset, length },
      );
    }
  }

  const submission = await tx.submission.create({
    data: {
      kind: AI_SUMMARY,
      content: body.content,
      modelProvider: body.modelProvider,
      modelName: body.modelName,
      generatedAt,
      inputSourceBlockIds: JSON.stringify(inputIds),
    },
  });

  const citations: CitationSpanModel[] = [];
  for (const c of citationInputs) {
    const block = sourceBlocks.get(c.sourceBlockId)!;
    const span = await tx.citationSpan.create({
      data: {
        submissionId: submission.id,
        sourceBlockId: c.sourceBlockId,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        citedHash: block.contentHash as string,
      },
    });
    citations.push(span);
  }

  return { submission, citations };
}

async function serializeAfterCreate(
  tx: Prisma.TransactionClient,
  submission: SubmissionModel,
  citations: CitationSpanModel[],
): Promise<SubmissionDto> {
  if (submission.kind !== AI_SUMMARY) {
    return serializeSubmission(submission, citations);
  }
  const sourceIds = Array.from(new Set(citations.map((c) => c.sourceBlockId)));
  const sourceBlocks = await loadSourceBlocksMap(tx, sourceIds);
  const coverage = coverageForSubmission(submission, citations, sourceBlocks);
  return serializeSubmission(submission, citations, coverage.coveragePermille);
}
