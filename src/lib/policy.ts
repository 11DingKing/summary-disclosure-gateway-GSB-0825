import {
  AI_SUMMARY,
  POLICY_V1,
  POLICY_V1_MIN_COVERAGE_PERMILLE,
} from "../constants.js";
import type { Kind } from "../constants.js";
import type { InvalidCitation } from "./coverage.js";

export interface PolicyContext {
  kind: Kind;
  coveragePermille: number;
  invalidCitations: InvalidCitation[];
}

export interface PolicyRejection {
  code:
    | "UNSUPPORTED_POLICY_VERSION"
    | "COVERAGE_TOO_LOW"
    | "SOURCE_HASH_INVALID";
  message: string;
  details?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  rejections: PolicyRejection[];
}

/**
 * Evaluate a publication policy.
 *
 * Policy v1 applies only to AI_SUMMARY submissions. It requires:
 *   1. coveragePermille >= 700
 *   2. every citation references an existing source block whose current hash
 *      matches the hash captured at citation time
 *
 * Non-AI submissions (source excerpts, reader notes, editor summaries) have no
 * attribution surface and pass policy v1 unconditionally.
 */
export function evaluatePolicy(
  policyVersion: number,
  ctx: PolicyContext,
): PolicyDecision {
  if (policyVersion !== POLICY_V1) {
    return {
      allowed: false,
      rejections: [
        {
          code: "UNSUPPORTED_POLICY_VERSION",
          message: `Policy version ${policyVersion} is not supported.`,
          details: { supportedVersions: [POLICY_V1] },
        },
      ],
    };
  }

  if (ctx.kind !== AI_SUMMARY) {
    return { allowed: true, rejections: [] };
  }

  const rejections: PolicyRejection[] = [];

  if (ctx.coveragePermille < POLICY_V1_MIN_COVERAGE_PERMILLE) {
    rejections.push({
      code: "COVERAGE_TOO_LOW",
      message: `AI summary coverage ${ctx.coveragePermille} is below the required minimum of ${POLICY_V1_MIN_COVERAGE_PERMILLE}.`,
      details: {
        coveragePermille: ctx.coveragePermille,
        minCoveragePermille: POLICY_V1_MIN_COVERAGE_PERMILLE,
      },
    });
  }

  if (ctx.invalidCitations.length > 0) {
    rejections.push({
      code: "SOURCE_HASH_INVALID",
      message:
        "One or more citations reference missing or stale source blocks.",
      details: {
        invalidCitations: ctx.invalidCitations,
      },
    });
  }

  return { allowed: rejections.length === 0, rejections };
}
