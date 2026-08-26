import type {
  Citation,
  Prisma,
  PrismaClient,
  Submission,
} from "@prisma/client";
import { computeCoverage, type CoverageResult } from "./coverage.js";

/**
 * Any Prisma executor — the full client or a `$transaction` handle. Serialize
 * helpers accept either so they can run inside or outside a transaction.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export type SubmissionWithCitations = Submission & { citations: Citation[] };

export function parseInputBlockIds(stored: string | null): string[] {
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export interface SerializedCitation {
  id: string;
  sourceBlockId: string;
  sourceContentHash: string;
  outputStart: number;
  outputEnd: number;
  sourceStart: number | null;
  sourceEnd: number | null;
  ordinal: number;
}

export function serializeCitation(c: Citation): SerializedCitation {
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

export interface CitationValidity {
  citation: Citation;
  valid: boolean;
  reason: "SOURCE_BLOCK_NOT_FOUND" | "SOURCE_HASH_MISMATCH" | null;
  currentHash: string | null;
}

export interface AiEvaluation {
  coverage: CoverageResult;
  validities: CitationValidity[];
}

/**
 * Re-derive an AI summary's citation validity and coverage from *current*
 * source state. A citation is valid only if its pinned `sourceContentHash`
 * still equals the referenced block's live hash; a revised or deleted source
 * therefore silently drops out of the coverage numerator. This is the single
 * source of truth for coverage — the stored `coveragePermille` column is never
 * trusted on read.
 */
export async function evaluateAiSubmission(
  db: DbClient,
  submission: SubmissionWithCitations,
): Promise<AiEvaluation> {
  const citations = [...submission.citations].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const sourceIds = [...new Set(citations.map((c) => c.sourceBlockId))];
  const sources = sourceIds.length
    ? await db.submission.findMany({ where: { id: { in: sourceIds } } })
    : [];
  const hashById = new Map(sources.map((s) => [s.id, s.contentHash]));

  const validities: CitationValidity[] = citations.map((citation) => {
    const currentHash = hashById.get(citation.sourceBlockId) ?? null;
    if (currentHash === null) {
      return {
        citation,
        valid: false,
        reason: "SOURCE_BLOCK_NOT_FOUND",
        currentHash: null,
      };
    }
    if (currentHash !== citation.sourceContentHash) {
      return {
        citation,
        valid: false,
        reason: "SOURCE_HASH_MISMATCH",
        currentHash,
      };
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

export interface SerializedSubmission {
  id: string;
  kind: string;
  docKey: string | null;
  body: string;
  version: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sourceRevision: number;
  contentHash: string | null;
  modelProvider: string | null;
  modelName: string | null;
  generatedAt: string | null;
  inputBlockIds: string[];
  citations: SerializedCitation[];
  coveragePermille: number | null;
  createdAt: string;
  updatedAt: string;
}

export async function serializeSubmission(
  db: DbClient,
  submission: SubmissionWithCitations,
): Promise<SerializedSubmission> {
  const citations = [...submission.citations].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const aiEvaluation =
    submission.kind === "AI_SUMMARY"
      ? await evaluateAiSubmission(db, submission)
      : null;

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
    generatedAt: submission.generatedAt
      ? submission.generatedAt.toISOString()
      : null,
    inputBlockIds: parseInputBlockIds(submission.inputBlockIds),
    citations: citations.map(serializeCitation),
    coveragePermille: aiEvaluation
      ? aiEvaluation.coverage.coveragePermille
      : null,
    createdAt: submission.createdAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
  };
}
