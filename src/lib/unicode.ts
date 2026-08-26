/**
 * Unicode-aware string helpers.
 *
 * Citation offsets are measured in Unicode code points (what end users perceive
 * as "characters"), not UTF-16 code units. This matters for emoji, astral
 * characters and combining marks where `String.prototype.length` would give a
 * different value.
 */

export function toCodePoints(content: string): string[] {
  return Array.from(content);
}

export function codePointLength(content: string): number {
  let count = 0;
  for (const _ of content) count++;
  return count;
}

const WHITESPACE_RE = /\p{White_Space}/u;

export function isWhitespace(codePoint: string): boolean {
  return WHITESPACE_RE.test(codePoint);
}

export function sliceByCodePoints(
  content: string,
  start: number,
  end: number,
): string {
  return toCodePoints(content).slice(start, end).join("");
}
