import type { Citation, Prisma } from '@prisma/client';
import { computeCoverage, type CoverageResult } from './coverage.js';

export type DbClient = Prisma.TransactionClient;
export type SubmissionWithCitations = Prisma.SubmissionGetPayload<{
  include: { citations: true };
}>;

export interface CitationValidity {
  citation: Citation;
  valid: boolean;
  reason: 'SOURCE_BLOCK_NOT_FOUND' | 'SOURCE_HASH_MISMATCH' | null;
  currentHash: string | null;
}

export interface AiEvaluation {
  coverage: CoverageResult;
  validities: CitationValidity[];
}

export function parseInputBlockIds(stored: string | null): string[] {
  if (!stored) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export function serializeCitation(c: Citation) {
  return {
    id: c.id,
    sourceBlockId: c.sourceBlockId,
    sourceContentHash: c.sourceContentHash,
    outputStart: c.outputStart,
    outputEnd: c.outputEnd,
    sourceStart: c.sourceStart,
    sourceEnd: c.sourceEnd,
    ordinal: c.ordinal,
  };
}

export async function evaluateAiSubmission(
  db: DbClient,
  submission: SubmissionWithCitations,
): Promise<AiEvaluation> {
  const citations = [...submission.citations].sort((a, b) => a.ordinal - b.ordinal);
  const sourceIds = [...new Set(citations.map((c) => c.sourceBlockId))];
  const sources = sourceIds.length
    ? await db.submission.findMany({ where: { id: { in: sourceIds } } })
    : [];
  const hashById = new Map<string, string | null>(
    sources.map((s) => [s.id, s.contentHash]),
  );

  const validities: CitationValidity[] = citations.map((citation) => {
    const currentHash = hashById.get(citation.sourceBlockId) ?? null;
    if (currentHash === null) {
      return { citation, valid: false, reason: 'SOURCE_BLOCK_NOT_FOUND', currentHash: null };
    }
    if (currentHash !== citation.sourceContentHash) {
      return { citation, valid: false, reason: 'SOURCE_HASH_MISMATCH', currentHash };
    }
    return { citation, valid: true, reason: null, currentHash };
  });

  const coverage = computeCoverage(
    submission.body,
    citations.map((c, i) => ({
      outputStart: c.outputStart,
      outputEnd: c.outputEnd,
      valid: validities[i]?.valid ?? false,
    })),
  );

  return { coverage, validities };
}

export async function serializeSubmission(
  db: DbClient,
  submission: SubmissionWithCitations,
): Promise<Record<string, unknown>> {
  const citations = [...submission.citations].sort((a, b) => a.ordinal - b.ordinal);
  const aiEvaluation =
    submission.kind === 'AI_SUMMARY' ? await evaluateAiSubmission(db, submission) : null;

  return {
    id: submission.id,
    kind: submission.kind,
    docKey: submission.docKey,
    body: submission.body,
    version: submission.version,
    pageStart: submission.pageStart,
    pageEnd: submission.pageEnd,
    sourceRevision: submission.sourceRevision,
    contentHash: submission.contentHash,
    modelProvider: submission.modelProvider,
    modelName: submission.modelName,
    generatedAt: submission.generatedAt ? submission.generatedAt.toISOString() : null,
    inputBlockIds: parseInputBlockIds(submission.inputBlockIds),
    citations: citations.map(serializeCitation),
    coveragePermille: aiEvaluation ? aiEvaluation.coverage.coveragePermille : null,
    createdAt: submission.createdAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
  };
}
