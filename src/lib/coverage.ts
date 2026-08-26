import { COVERAGE_PERMILLE_MAX } from "../constants.js";
import { codePointLength, isWhitespace, toCodePoints } from "./unicode.js";

export interface CoverageCitation {
  sourceBlockId: string;
  startOffset: number;
  endOffset: number;
  citedHash: string;
}

export type CitationInvalidReason =
  | "SOURCE_NOT_FOUND"
  | "SOURCE_HASH_MISMATCH"
  | "OFFSET_OUT_OF_BOUNDS";

export interface InvalidCitation {
  index: number;
  sourceBlockId: string;
  reason: CitationInvalidReason;
}

export interface CoverageResult {
  coveragePermille: number;
  coveredNonWhitespace: number;
  totalNonWhitespace: number;
  validCitationCount: number;
  invalidCitations: InvalidCitation[];
}

/**
 * Compute coveragePermille for an AI summary.
 *
 *   coveragePermille =
 *     floor( (non-whitespace code points covered by >=1 valid citation)
 *            / (all non-whitespace code points) * 1000 )
 *
 * Overlapping citation ranges are unioned ("去重") via a boolean mask, so
 * overlapping spans never inflate coverage. Whitespace inside a cited range is
 * not counted as covered content, because the denominator only counts
 * non-whitespace. The result is clamped to [0, 1000].
 *
 * A citation is "valid" iff:
 *   - its referenced source block still exists, and
 *   - the source block's current contentHash equals the hash recorded when the
 *     citation was created (no source drift), and
 *   - its offsets are integers within [0, codePointLength(content)] with
 *     start < end.
 *
 * The server always computes this value; any client-supplied coverage is
 * ignored.
 */
export function computeCoverage(
  content: string,
  citations: CoverageCitation[],
  sourceHashes: Map<string, string | null>,
): CoverageResult {
  const chars = toCodePoints(content);
  const length = chars.length;
  const covered = new Uint8Array(length);
  const invalidCitations: InvalidCitation[] = [];
  let validCitationCount = 0;

  citations.forEach((citation, index) => {
    const currentHash = sourceHashes.get(citation.sourceBlockId);
    if (currentHash === undefined) {
      invalidCitations.push({
        index,
        sourceBlockId: citation.sourceBlockId,
        reason: "SOURCE_NOT_FOUND",
      });
      return;
    }
    if (currentHash !== citation.citedHash) {
      invalidCitations.push({
        index,
        sourceBlockId: citation.sourceBlockId,
        reason: "SOURCE_HASH_MISMATCH",
      });
      return;
    }
    const { startOffset, endOffset } = citation;
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset > length ||
      startOffset >= endOffset
    ) {
      invalidCitations.push({
        index,
        sourceBlockId: citation.sourceBlockId,
        reason: "OFFSET_OUT_OF_BOUNDS",
      });
      return;
    }

    for (let p = startOffset; p < endOffset; p++) {
      covered[p] = 1;
    }
    validCitationCount++;
  });

  let totalNonWhitespace = 0;
  let coveredNonWhitespace = 0;
  for (let i = 0; i < length; i++) {
    if (!isWhitespace(chars[i])) {
      totalNonWhitespace++;
      if (covered[i] === 1) coveredNonWhitespace++;
    }
  }

  const coveragePermille =
    totalNonWhitespace === 0
      ? 0
      : Math.min(
          COVERAGE_PERMILLE_MAX,
          Math.floor((coveredNonWhitespace * 1000) / totalNonWhitespace),
        );

  return {
    coveragePermille,
    coveredNonWhitespace,
    totalNonWhitespace,
    validCitationCount,
    invalidCitations,
  };
}

export { codePointLength };
