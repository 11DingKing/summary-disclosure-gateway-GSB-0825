export interface Span {
  start: number;
  end: number;
}

/**
 * coveragePermille = floor(
 *   unique non-whitespace output chars covered by >= 1 valid span
 *   / non-whitespace output chars * 1000
 * )
 *
 * - Offsets are Unicode code-point indices (surrogate pairs count as one char).
 * - Overlapping spans are de-duplicated: a covered char counts once.
 * - Whitespace counts in neither numerator nor denominator, so 0 <= result <= 1000.
 * - Server-side only; client-supplied values are never trusted.
 */
export function computeCoveragePermille(text: string, spans: Span[]): number {
  const chars = Array.from(text);
  const isNonWs = chars.map((c) => !/\s/u.test(c));
  const total = isNonWs.reduce<number>((n, flag) => n + (flag ? 1 : 0), 0);
  if (total === 0) return 0;

  const covered = new Array<boolean>(chars.length).fill(false);
  for (const { start, end } of spans) {
    const s = Math.max(0, Math.min(start, chars.length));
    const e = Math.max(0, Math.min(end, chars.length));
    for (let i = s; i < e; i++) covered[i] = true;
  }

  let coveredCount = 0;
  for (let i = 0; i < chars.length; i++) {
    if (isNonWs[i] && covered[i]) coveredCount++;
  }
  return Math.floor((coveredCount * 1000) / total);
}

/** A span is addressable only if it is a non-empty code-point range inside the text. */
export function spanInBounds(span: Span, text: string): boolean {
  const len = Array.from(text).length;
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.start < span.end &&
    span.end <= len
  );
}
