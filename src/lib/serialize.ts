import type {
  CitationSpan as CitationSpanModel,
  Publication as PublicationModel,
  Prisma,
  Submission as SubmissionModel,
} from "@prisma/client";
import { AI_SUMMARY, SOURCE_EXCERPT, type Kind } from "../constants.js";
import type {
  CitationSpanRecord,
  PublicationDto,
  PublicationSnapshot,
  SubmissionDto,
} from "../types.js";
import { computeCoverage, type CoverageResult } from "./coverage.js";
import { codePointLength } from "./unicode.js";

type SourceBlockRow = Pick<
  SubmissionModel,
  "id" | "kind" | "content" | "contentHash" | "version" | "page" | "revision"
>;

export function parseInputSourceBlockIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeCitationSpan(
  c: CitationSpanModel,
): CitationSpanRecord {
  return {
    id: c.id,
    submissionId: c.submissionId,
    sourceBlockId: c.sourceBlockId,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    citedHash: c.citedHash,
    createdAt: toIso(c.createdAt),
  };
}

export function serializeSubmission(
  s: SubmissionModel,
  citations?: CitationSpanModel[],
  coveragePermille?: number,
): SubmissionDto {
  const dto: SubmissionDto = {
    id: s.id,
    kind: s.kind as Kind,
    content: s.content,
    revision: s.revision,
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
  };

  if (s.kind === SOURCE_EXCERPT) {
    dto.version = s.version ?? undefined;
    dto.page = s.page ?? undefined;
    dto.contentHash = s.contentHash ?? undefined;
  }

  if (s.kind === AI_SUMMARY) {
    dto.modelProvider = s.modelProvider ?? undefined;
    dto.modelName = s.modelName ?? undefined;
    dto.generatedAt = s.generatedAt ? toIso(s.generatedAt) : undefined;
    dto.inputSourceBlockIds = parseInputSourceBlockIds(s.inputSourceBlockIds);
    if (citations) {
      dto.citations = citations.map(serializeCitationSpan);
    }
    if (coveragePermille !== undefined) {
      dto.coveragePermille = coveragePermille;
    }
  }

  return dto;
}

export function serializePublication(p: PublicationModel): PublicationDto {
  return {
    id: p.id,
    submissionId: p.submissionId,
    policyVersion: p.policyVersion,
    revision: p.revision,
    coveragePermille: p.coveragePermille,
    sourceHashesValid: p.sourceHashesValid,
    publishedAt: toIso(p.publishedAt),
    snapshot: JSON.parse(p.snapshot) as PublicationSnapshot,
  };
}

export async function loadSourceBlocksMap(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<Map<string, SourceBlockRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.submission.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      content: true,
      contentHash: true,
      version: true,
      page: true,
      revision: true,
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Build a hash map of sourceBlockId -> current contentHash for coverage
 * evaluation. A source block that does not exist is omitted from the map
 * (computeCoverage treats missing ids as SOURCE_NOT_FOUND).
 */
export function buildSourceHashMap(
  sourceBlocks: Map<string, SourceBlockRow>,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const [id, row] of sourceBlocks) {
    map.set(id, row.contentHash);
  }
  return map;
}

export function coverageForSubmission(
  submission: SubmissionModel,
  citations: CitationSpanModel[],
  sourceBlocks: Map<string, SourceBlockRow>,
): CoverageResult {
  const hashMap = buildSourceHashMap(sourceBlocks);
  return computeCoverage(
    submission.content,
    citations.map((c) => ({
      sourceBlockId: c.sourceBlockId,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      citedHash: c.citedHash,
    })),
    hashMap,
  );
}

/**
 * Attach a live `coveragePermille` to every AI_SUMMARY in the batch. Source
 * blocks are loaded in a single query to avoid N+1.
 */
export async function attachCoverage(
  tx: Prisma.TransactionClient,
  items: Array<{
    submission: SubmissionModel;
    citations: CitationSpanModel[];
  }>,
): Promise<Map<string, CoverageResult>> {
  const aiItems = items.filter((i) => i.submission.kind === AI_SUMMARY);
  const sourceIds = new Set<string>();
  for (const { citations } of aiItems) {
    for (const c of citations) sourceIds.add(c.sourceBlockId);
  }
  const sourceBlocks = await loadSourceBlocksMap(tx, Array.from(sourceIds));
  const results = new Map<string, CoverageResult>();
  for (const { submission, citations } of aiItems) {
    results.set(
      submission.id,
      coverageForSubmission(submission, citations, sourceBlocks),
    );
  }
  return results;
}

export function buildSnapshot(
  submission: SubmissionModel,
  citations: CitationSpanModel[],
  sourceBlocks: Map<string, SourceBlockRow>,
  coverage: CoverageResult,
  policyVersion: number,
  publishedAt: Date,
): PublicationSnapshot {
  return {
    publishedAt: publishedAt.toISOString(),
    policyVersion,
    revision: submission.revision,
    coveragePermille: coverage.coveragePermille,
    sourceHashesValid: coverage.invalidCitations.length === 0,
    submission: {
      id: submission.id,
      kind: submission.kind as Kind,
      content: submission.content,
      version: submission.version,
      page: submission.page,
      contentHash: submission.contentHash,
      modelProvider: submission.modelProvider,
      modelName: submission.modelName,
      generatedAt: submission.generatedAt
        ? submission.generatedAt.toISOString()
        : null,
      inputSourceBlockIds: parseInputSourceBlockIds(
        submission.inputSourceBlockIds,
      ),
      revision: submission.revision,
      createdAt: submission.createdAt.toISOString(),
      updatedAt: submission.updatedAt.toISOString(),
    },
    citations: citations.map((c) => {
      const src = sourceBlocks.get(c.sourceBlockId);
      return {
        id: c.id,
        sourceBlockId: c.sourceBlockId,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        citedHash: c.citedHash,
        sourceBlockContent: src?.content ?? null,
        sourceBlockVersion: src?.version ?? null,
        sourceBlockPage: src?.page ?? null,
        sourceBlockHash: src?.contentHash ?? null,
      };
    }),
  };
}

export { codePointLength };
