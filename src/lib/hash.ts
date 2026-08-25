import { createHash } from "node:crypto";

/**
 * Compute the content hash used for source-excerpt integrity and citation
 * validity checks. The hash is computed server-side only; clients never supply
 * it.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
