import {
  evaluateAiSubmission,
  type DbClient,
  type SubmissionWithCitations,
} from "./serialize.js";
import type { PolicyReason } from "./errors.js";

export const POLICY_VERSIONS = ["v1"] as const;
export type PolicyVersion = (typeof POLICY_VERSIONS)[number];

/** Policy v1 threshold: AI summaries must reach at least 700 per mille coverage. */
export const V1_MIN_COVERAGE_PERMILLE = 700;

export interface AiPolicyResult {
  submissionId: string;
  coveragePermille: number;
  coveredNonWhitespace: number;
  totalNonWhitespace: number;
  validCitationCount: number;
  invalidCitationCount: number;
}

export interface PolicyEvaluation {
  results: AiPolicyResult[];
  reasons: PolicyReason[];
}

/**
 * Evaluate policy v1 over the full set of submissions being published.
 *
 * For every AI_SUMMARY: each citation must still hash-match its source block,
 * and the server-recomputed coverage must be >= 700 per mille. Every failure
 * becomes a machine-readable reason (hash mismatch / missing source / low
 * coverage). Non-AI kinds are unconstrained by v1. Coverage is always
 * recomputed here, never read from client input or the stored column.
 */
export async function evaluatePolicyV1(
  db: DbClient,
  submissions: SubmissionWithCitations[],
): Promise<PolicyEvaluation> {
  const results: AiPolicyResult[] = [];
  const reasons: PolicyReason[] = [];

  for (const submission of submissions) {
    if (submission.kind !== "AI_SUMMARY") {
      continue;
    }
    const { coverage, validities } = await evaluateAiSubmission(db, submission);

    for (const validity of validities) {
      if (validity.valid) {
        continue;
      }
      reasons.push({
        code: validity.reason ?? "SOURCE_HASH_MISMATCH",
        submissionId: submission.id,
        citationSpanId: validity.citation.id,
        sourceBlockId: validity.citation.sourceBlockId,
        citedHash: validity.citation.sourceContentHash,
        currentHash: validity.currentHash,
      });
    }

    if (coverage.coveragePermille < V1_MIN_COVERAGE_PERMILLE) {
      reasons.push({
        code: "INSUFFICIENT_COVERAGE",
        submissionId: submission.id,
        coveragePermille: coverage.coveragePermille,
        requiredPermille: V1_MIN_COVERAGE_PERMILLE,
        coveredNonWhitespace: coverage.coveredNonWhitespace,
        totalNonWhitespace: coverage.totalNonWhitespace,
      });
    }

    results.push({
      submissionId: submission.id,
      coveragePermille: coverage.coveragePermille,
      coveredNonWhitespace: coverage.coveredNonWhitespace,
      totalNonWhitespace: coverage.totalNonWhitespace,
      validCitationCount: validities.filter((v) => v.valid).length,
      invalidCitationCount: validities.filter((v) => !v.valid).length,
    });
  }

  return { results, reasons };
}
