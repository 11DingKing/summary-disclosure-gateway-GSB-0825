import { Prisma } from "@prisma/client";
import { computeCoveragePermille, spanInBounds, type Span } from "./coverage";
import type { CitationSpan } from "./types";

export const POLICY_V1 = "v1";
export const SUPPORTED_POLICY_VERSIONS = [POLICY_V1] as const;
export const POLICY_V1_MIN_COVERAGE_PERMILLE = 700;

export interface RejectionReason {
  code: string;
  [key: string]: unknown;
}

export interface SourceLike {
  id: string;
  contentHash: string;
}

/**
 * A citation is valid only if its span is in bounds and the recorded source
 * hash still matches the source block's current content hash.
 */
export function assessCitations(
  text: string,
  citations: CitationSpan[],
  sourcesById: Map<string, SourceLike>,
): { validSpans: Span[]; problems: RejectionReason[] } {
  const validSpans: Span[] = [];
  const problems: RejectionReason[] = [];

  citations.forEach((c, index) => {
    if (!spanInBounds(c, text)) {
      problems.push({
        code: "INVALID_CITATION_SPAN",
        citationIndex: index,
        start: c.start,
        end: c.end,
      });
      return;
    }
    const source = sourcesById.get(c.sourceBlockId);
    if (!source) {
      problems.push({
        code: "UNKNOWN_SOURCE_BLOCK",
        citationIndex: index,
        sourceBlockId: c.sourceBlockId,
      });
      return;
    }
    if (source.contentHash !== c.sourceHash) {
      problems.push({
        code: "SOURCE_HASH_MISMATCH",
        citationIndex: index,
        sourceBlockId: c.sourceBlockId,
        expectedHash: c.sourceHash,
        actualHash: source.contentHash,
      });
      return;
    }
    validSpans.push({ start: c.start, end: c.end });
  });

  return { validSpans, problems };
}

/**
 * Policy v1: AI summary coverage must be >= 700 permille and every cited
 * source hash must still be valid. Reasons are machine-readable.
 */
export function evaluatePolicyV1(
  text: string,
  citations: CitationSpan[],
  sourcesById: Map<string, SourceLike>,
): { coveragePermille: number; reasons: RejectionReason[] } {
  const { validSpans, problems } = assessCitations(
    text,
    citations,
    sourcesById,
  );
  const coveragePermille = computeCoveragePermille(text, validSpans);
  const reasons: RejectionReason[] = [];

  if (coveragePermille < POLICY_V1_MIN_COVERAGE_PERMILLE) {
    reasons.push({
      code: "COVERAGE_BELOW_THRESHOLD",
      required: POLICY_V1_MIN_COVERAGE_PERMILLE,
      actual: coveragePermille,
    });
  }
  reasons.push(...problems);
  return { coveragePermille, reasons };
}

export async function bumpRevision(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const state = await tx.gatewayState.upsert({
    where: { id: 1 },
    create: { id: 1, revision: 1 },
    update: { revision: { increment: 1 } },
  });
  return state.revision;
}
