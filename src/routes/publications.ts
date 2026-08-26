import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  AppError,
  notFound,
  policyViolation,
  validationError,
} from "../lib/errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../lib/cursor.js";
import { withBusyRetry } from "../lib/concurrency.js";
import {
  withIdempotency,
  idempotencyKeyFromHeaders,
} from "../lib/idempotency.js";
import { evaluatePolicyV1, POLICY_VERSIONS } from "../lib/policy.js";
import {
  buildSnapshot,
  parseSnapshot,
  serializePublication,
} from "../lib/snapshot.js";
import {
  serializeSubmission,
  type SubmissionWithCitations,
} from "../lib/serialize.js";
import { parseStringArray, requireObject } from "../lib/validation.js";
import type { HandlerResult } from "../lib/idempotency.js";

const DEFAULT_SCOPE = "default";

interface RouteOptions extends FastifyPluginOptions {
  db: PrismaClient;
}

const publicationsRoutes = async (
  app: FastifyInstance,
  options: RouteOptions,
): Promise<void> => {
  const db = options.db;

  app.post("/publications", async (request, reply) => {
    const idempotencyKey = idempotencyKeyFromHeaders(
      request.headers as Record<string, unknown>,
    );
    const body = requireObject(request.body);
    const outcome = await withIdempotency(
      db,
      "POST /v1/publications",
      idempotencyKey,
      body,
      async () => withBusyRetry(() => publishOnce(db, body)),
    );
    return reply
      .code(outcome.statusCode)
      .header("Idempotency-Replayed", outcome.replay ? "true" : "false")
      .send(outcome.body);
  });

  app.get("/publications", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = parseLimit(query.limit);
    const where: Prisma.PublicationWhereInput = {};

    if (query.scope !== undefined) {
      if (typeof query.scope !== "string" || query.scope.trim().length === 0) {
        throw validationError('"scope" must be a non-empty string', {
          field: "scope",
        });
      }
      where.scope = query.scope.trim();
    }

    let cursorCondition: Prisma.PublicationWhereInput | undefined;
    if (query.cursor !== undefined && query.cursor !== "") {
      const cursor = decodeCursor(String(query.cursor));
      const createdAt = new Date(cursor.createdAt);
      cursorCondition = {
        OR: [
          { createdAt: { gt: createdAt } },
          { createdAt, id: { gt: cursor.id } },
        ],
      };
    }

    const rows = await db.publication.findMany({
      where: cursorCondition ? { AND: [where, cursorCondition] } : where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((publication) => serializePublication(publication));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { items, nextCursor, limit, hasMore };
  });

  app.get("/publications/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const publication = await db.publication.findUnique({
      where: { id: params.id },
    });
    if (!publication) {
      throw notFound("Publication not found", { publicationId: params.id });
    }
    return reply.send(
      serializePublication(publication, parseSnapshot(publication.snapshot)),
    );
  });
};

/**
 * Perform one publish attempt inside a serializable transaction.
 *
 * Steps: check optimistic concurrency (expectedRevision must equal the scope's
 * latest revision), load the selected submissions plus any source blocks they
 * cite, run policy v1, and — only if the policy passes — persist an immutable
 * snapshot at the next revision. The unique (scope, revision) constraint plus
 * the busy-retry wrapper make concurrent publishes to the same scope serialize:
 * exactly one wins each revision, the losers see REVISION_CONFLICT.
 */
async function publishOnce(
  db: PrismaClient,
  body: Record<string, unknown>,
): Promise<HandlerResult> {
  const policyVersion = body.policyVersion;
  if (
    typeof policyVersion !== "string" ||
    !(POLICY_VERSIONS as readonly string[]).includes(policyVersion)
  ) {
    throw new AppError(
      400,
      "UNSUPPORTED_POLICY_VERSION",
      'Unsupported "policyVersion"',
      { requested: policyVersion, supportedPolicyVersions: POLICY_VERSIONS },
    );
  }

  const scope =
    typeof body.scope === "string" && body.scope.trim().length > 0
      ? body.scope.trim()
      : DEFAULT_SCOPE;
  if (scope.length > 100) {
    throw validationError('"scope" must not exceed 100 characters', {
      field: "scope",
    });
  }

  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw validationError('"expectedRevision" must be a non-negative integer', {
      field: "expectedRevision",
    });
  }

  const submissionIds = [
    ...new Set(parseStringArray(body.submissionIds, "submissionIds")),
  ];
  if (submissionIds.length === 0) {
    throw validationError('"submissionIds" must be a non-empty array', {
      field: "submissionIds",
    });
  }

  return db.$transaction(
    async (tx) => {
      const latest = await tx.publication.findFirst({
        where: { scope },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const latestRevision = latest?.revision ?? 0;
      if (latestRevision !== expectedRevision) {
        throw new AppError(
          409,
          "REVISION_CONFLICT",
          '"expectedRevision" does not match the latest published revision in this scope',
          { scope, expectedRevision, latestRevision },
        );
      }

      const selected = (await tx.submission.findMany({
        where: { id: { in: submissionIds } },
        include: { citations: { orderBy: { ordinal: "asc" } } },
      })) as SubmissionWithCitations[];
      if (selected.length !== submissionIds.length) {
        const found = new Set(selected.map((s) => s.id));
        throw new AppError(
          404,
          "SUBMISSION_NOT_FOUND",
          'Some "submissionIds" do not exist',
          {
            missingSubmissionIds: submissionIds.filter((id) => !found.has(id)),
          },
        );
      }

      // Pull in any cited source blocks not explicitly selected, so the
      // snapshot is self-contained and policy sees the real source hashes.
      const selectedIds = new Set(submissionIds);
      const citedSourceIds = [
        ...new Set(
          selected.flatMap((s) => s.citations.map((c) => c.sourceBlockId)),
        ),
      ].filter((id) => !selectedIds.has(id));
      const citedSources = citedSourceIds.length
        ? ((await tx.submission.findMany({
            where: { id: { in: citedSourceIds } },
            include: { citations: { orderBy: { ordinal: "asc" } } },
          })) as SubmissionWithCitations[])
        : [];

      const allSubmissions = [...selected, ...citedSources];
      const policy = await evaluatePolicyV1(tx, allSubmissions);
      if (policy.reasons.length > 0) {
        throw policyViolation(policyVersion, policy.reasons);
      }

      const serializedSubmissions = [];
      for (const submission of allSubmissions) {
        serializedSubmissions.push(await serializeSubmission(tx, submission));
      }

      const revision = latestRevision + 1;
      const publishedAt = new Date();
      const snapshot = buildSnapshot({
        scope,
        revision,
        policyVersion,
        publishedAt,
        submissions: serializedSubmissions,
        aiResults: policy.results,
      });

      const publication = await tx.publication.create({
        data: {
          scope,
          revision,
          policyVersion,
          snapshot: JSON.stringify(snapshot),
        },
      });

      return {
        statusCode: 201,
        body: serializePublication(publication, snapshot),
      };
    },
    { timeout: 15_000 },
  );
}

export default publicationsRoutes;
