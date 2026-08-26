import { createHash } from "node:crypto";

/**
 * NUL is used as the canonical field delimiter. It cannot appear in the JSON
 * string inputs we hash, so the concatenation is unambiguous and two distinct
 * field tuples can never collide by shifting a delimiter into a value.
 */
const CANONICAL_DELIMITER = String.fromCharCode(0);

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface SourceHashInput {
  version: string;
  sourceRevision: number;
  pageStart: number;
  pageEnd: number;
  body: string;
}

/**
 * Canonical SHA-256 of a SOURCE_EXCERPT block. Every field that a citation
 * relies on (version, revision, page range, body) is folded in, so any source
 * revision produces a new hash and invalidates citations pinned to the old one.
 */
export function sourceContentHash(input: SourceHashInput): string {
  const canonical = [
    "SOURCE_EXCERPT",
    input.version,
    `rev${input.sourceRevision}`,
    `p${input.pageStart}-${input.pageEnd}`,
    input.body,
  ].join(CANONICAL_DELIMITER);
  return sha256(canonical);
}
