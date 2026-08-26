/**
 * Unicode-aware coverage math. All offsets in the gateway are Unicode code
 * points (not UTF-16 units), so a 4-byte emoji or an astral CJK character
 * counts as exactly one position — the same way a human would count them.
 */

/** Count Unicode code points (iterating the string yields code points). */
export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) {
    n += 1;
  }
  return n;
}

/** Explode a string into an array of code-point strings. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Whitespace test over a single code point, using the Unicode `\s` class. */
export function isWhitespace(codePointChar: string): boolean {
  return /\s/u.test(codePointChar);
}

export interface CoverageSpan {
  outputStart: number;
  outputEnd: number;
  valid: boolean;
}

export interface CoverageResult {
  coveragePermille: number;
  coveredNonWhitespace: number;
  totalNonWhitespace: number;
  codePointLength: number;
}

/**
 * Compute citation coverage over an AI summary body.
 *
 * Coverage = deduplicated non-whitespace output code points covered by at least
 * one *valid* citation span, divided by total non-whitespace output code points,
 * expressed in per mille and floored. Overlapping spans are deduplicated by
 * painting a per-position bitmap, so double-citing the same characters cannot
 * inflate the score. Whitespace never counts toward numerator or denominator.
 */
export function computeCoverage(
  output: string,
  spans: CoverageSpan[],
): CoverageResult {
  const chars = codePoints(output);
  const covered = new Uint8Array(chars.length);

  for (const span of spans) {
    if (!span.valid) {
      continue;
    }
    const start = Math.max(
      0,
      Math.min(chars.length, Math.trunc(span.outputStart)),
    );
    const end = Math.max(
      start,
      Math.min(chars.length, Math.trunc(span.outputEnd)),
    );
    for (let i = start; i < end; i += 1) {
      covered[i] = 1;
    }
  }

  let totalNonWhitespace = 0;
  let coveredNonWhitespace = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (isWhitespace(ch)) {
      continue;
    }
    totalNonWhitespace += 1;
    if (covered[i] === 1) {
      coveredNonWhitespace += 1;
    }
  }

  const coveragePermille =
    totalNonWhitespace === 0
      ? 0
      : Math.min(
          1000,
          Math.floor((coveredNonWhitespace * 1000) / totalNonWhitespace),
        );

  return {
    coveragePermille,
    coveredNonWhitespace,
    totalNonWhitespace,
    codePointLength: chars.length,
  };
}
