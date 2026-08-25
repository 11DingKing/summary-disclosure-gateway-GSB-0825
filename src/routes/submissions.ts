import type { FastifyPluginAsync } from 'fastify';
import type { Prisma, PrismaClient, Submission } from '@prisma/client';
import { AppError, notFound, validationError } from '../lib/errors.js';
import { sourceContentHash } from '../lib/hash.js';
import { codePointLength } from '../lib/coverage.js';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/cursor.js';
import { withIdempotency, idempotencyKeyFromHeaders } from '../lib/idempotency.js';
import { serializeSubmission } from '../lib/serialize.js';
import {
  isKind,
  optionalTrimmedString,
  parseCitationSpans,
  parseDateField,
  parsePageRange,
  parseStringArray,
  requireBody,
  requireNonEmptyString,
  requireObject,
} from '../lib/validation.js';

export interface SubmissionsRouteOptions {
  db: PrismaClient;
}

const submissionsRoutes: FastifyPluginAsync<SubmissionsRouteOptions> = async (app, options) => {
  const db = options.db;

  app.post('/submissions', async (request, reply) => {
    const idempotencyKey = idempotencyKeyFromHeaders(
      request.headers as Record<string, unknown>,
    );
    const body = requireObject(request.body);

    const outcome = await withIdempotency(
      db,
      'POST /v1/submissions',
      idempotencyKey,
      body,
      async () => {
        const created = await createSubmission(db, body);
        return {
          statusCode: 201,
          body: await serializeSubmission(db, created),
        };
      },
    );

    return reply
      .code(outcome.statusCode)
      .header('Idempotency-Replayed', outcome.replay ? 'true' : 'false')
      .send(outcome.body);
  });

  app.get('/submissions', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = parseLimit(query.limit);

    const where: Prisma.SubmissionWhereInput = {};
    if (query.kind !== undefined) {
      if (!isKind(query.kind)) {
        throw validationError('"kind" must be one of the four submission kinds', {
          field: 'kind',
        });
      }
      where.kind = query.kind;
    }
    if (query.docKey !== undefined) {
      if (typeof query.docKey !== 'string' || query.docKey.trim().length === 0) {
        throw validationError('"docKey" must be a non-empty string', { field: 'docKey' });
      }
      where.docKey = query.docKey;
    }

    let cursorCondition: Prisma.SubmissionWhereInput | undefined;
    if (query.cursor !== undefined && query.cursor !== '') {
      const cursor = decodeCursor(String(query.cursor));
      const createdAt = new Date(cursor.createdAt);
      cursorCondition = {
        OR: [
          { createdAt: { gt: createdAt } },
          { createdAt, id: { gt: cursor.id } },
        ],
      };
    }

    const rows = await db.submission.findMany({
      where: cursorCondition ? { AND: [where, cursorCondition] } : where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { citations: true },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = await Promise.all(page.map((row) => serializeSubmission(db, row)));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

    return { items, nextCursor, limit, hasMore };
  });

  app.get('/submissions/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const submission = await db.submission.findUnique({
      where: { id: params.id },
      include: { citations: true },
    });
    if (!submission) {
      throw notFound('Submission not found', { submissionId: params.id });
    }
    return reply.send(await serializeSubmission(db, submission));
  });

  app.patch('/submissions/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const existing = await db.submission.findUnique({
      where: { id: params.id },
      include: { citations: true },
    });
    if (!existing) {
      throw notFound('Submission not found', { submissionId: params.id });
    }
    if (existing.kind !== 'SOURCE_EXCERPT') {
      throw new AppError(
        409,
        'IMMUTABLE_SUBMISSION',
        'Only SOURCE_EXCERPT blocks support versioned revision; reader notes, editor summaries and AI summaries are immutable',
        { submissionId: existing.id, kind: existing.kind },
      );
    }

    const body = requireObject(request.body);
    const newVersion = requireNonEmptyString(body, 'version', 64).trim();
    if (newVersion === existing.version) {
      throw new AppError(
        409,
        'VERSION_MUST_ADVANCE',
        'A source revision must carry a new "version" different from the current one',
        { submissionId: existing.id, currentVersion: existing.version },
      );
    }

    const newBody =
      typeof body.body === 'string' && body.body.length > 0 ? body.body : existing.body;
    if (typeof body.body === 'string' && body.body.length === 0) {
      throw validationError('"body" must be a non-empty string', { field: 'body' });
    }

    let pageStart = existing.pageStart;
    let pageEnd = existing.pageEnd;
    if (body.pageStart !== undefined || body.pageEnd !== undefined) {
      const pages = parsePageRange(body);
      pageStart = pages.pageStart;
      pageEnd = pages.pageEnd;
    }
    if (pageStart === null || pageEnd === null) {
      throw validationError('Source excerpt is missing page numbers', {
        fields: ['pageStart', 'pageEnd'],
      });
    }

    const sourceRevision = existing.sourceRevision + 1;
    const contentHash = sourceContentHash({
      version: newVersion,
      sourceRevision,
      pageStart,
      pageEnd,
      body: newBody,
    });

    const updated = await db.submission.update({
      where: { id: existing.id },
      data: {
        body: newBody,
        version: newVersion,
        pageStart,
        pageEnd,
        sourceRevision,
        contentHash,
      },
      include: { citations: { orderBy: { ordinal: 'asc' } } },
    });

    return reply.send(await serializeSubmission(db, updated));
  });
};

async function createSubmission(
  db: PrismaClient,
  body: Record<string, unknown>,
): Promise<Prisma.SubmissionGetPayload<{ include: { citations: true } }>> {
  const kind = body.kind;
  if (!isKind(kind)) {
    throw validationError(
      '"kind" must be one of SOURCE_EXCERPT, READER_NOTE, EDITOR_SUMMARY, AI_SUMMARY',
      { field: 'kind', allowedKinds: ['SOURCE_EXCERPT', 'READER_NOTE', 'EDITOR_SUMMARY', 'AI_SUMMARY'] },
    );
  }

  const text = requireBody(body);
  const docKey = optionalTrimmedString(body, 'docKey');

  const data: Prisma.SubmissionUncheckedCreateInput = {
    kind,
    body: text,
    docKey,
  };

  if (kind === 'SOURCE_EXCERPT') {
    const version = requireNonEmptyString(body, 'version', 64).trim();
    const { pageStart, pageEnd } = parsePageRange(body);
    const sourceRevision = 1;
    data.version = version;
    data.pageStart = pageStart;
    data.pageEnd = pageEnd;
    data.sourceRevision = sourceRevision;
    data.contentHash = sourceContentHash({ version, sourceRevision, pageStart, pageEnd, body: text });
  }

  if (kind === 'AI_SUMMARY') {
    const modelProvider = requireNonEmptyString(body, 'modelProvider', 200).trim();
    const modelName = requireNonEmptyString(body, 'modelName', 200).trim();
    const generatedAt = parseDateField(body, 'generatedAt');
    const inputBlockIds = [...new Set(parseStringArray(body.inputBlockIds, 'inputBlockIds'))];
    if (inputBlockIds.length === 0) {
      throw validationError('AI_SUMMARY requires a non-empty "inputBlockIds" list', {
        field: 'inputBlockIds',
      });
    }

    const sources = await db.submission.findMany({
      where: { id: { in: inputBlockIds } },
    });
    const sourceById = new Map<string, Submission>(sources.map((s) => [s.id, s]));
    const missing = inputBlockIds.filter((id) => !sourceById.has(id));
    if (missing.length > 0) {
      throw new AppError(
        404,
        'SOURCE_BLOCK_NOT_FOUND',
        'Some "inputBlockIds" do not reference an existing submission',
        { missingSourceBlockIds: missing },
      );
    }
    const nonSource = sources
      .filter((s) => s.kind !== 'SOURCE_EXCERPT')
      .map((s) => s.id);
    if (nonSource.length > 0) {
      throw validationError(
        '"inputBlockIds" may only reference SOURCE_EXCERPT blocks',
        { nonSourceBlockIds: nonSource },
      );
    }

    const outputLength = codePointLength(text);
    const sourceLength = (sourceBlockId: string): number | null => {
      const source = sourceById.get(sourceBlockId);
      return source ? codePointLength(source.body) : null;
    };
    const citationInputs = parseCitationSpans(body.citations, outputLength, sourceLength);

    const unknownCitations = citationInputs
      .map((c) => c.sourceBlockId)
      .filter((id) => !sourceById.has(id));
    if (unknownCitations.length > 0) {
      throw validationError(
        'Every citation.sourceBlockId must be one of "inputBlockIds"',
        { unknownSourceBlockIds: [...new Set(unknownCitations)] },
      );
    }

    data.modelProvider = modelProvider;
    data.modelName = modelName;
    data.generatedAt = generatedAt;
    data.inputBlockIds = JSON.stringify(inputBlockIds);
    data.citations = {
      create: citationInputs.map((c) => {
        const source = sourceById.get(c.sourceBlockId);
        return {
          sourceBlockId: c.sourceBlockId,
          sourceContentHash: source?.contentHash ?? '',
          outputStart: c.outputStart,
          outputEnd: c.outputEnd,
          sourceStart: c.sourceStart,
          sourceEnd: c.sourceEnd,
          ordinal: c.ordinal,
        };
      }),
    };
  }

  return db.submission.create({
    data,
    include: { citations: { orderBy: { ordinal: 'asc' } } },
  });
}

export default submissionsRoutes;
