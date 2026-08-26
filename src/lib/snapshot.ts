import type { Publication } from "@prisma/client";
import { V1_MIN_COVERAGE_PERMILLE } from "./policy.js";
import type { AiPolicyResult } from "./policy.js";
import type { SerializedSubmission } from "./serialize.js";

export interface SnapshotInput {
  scope: string;
  revision: number;
  policyVersion: string;
  publishedAt: Date;
  submissions: SerializedSubmission[];
  aiResults: AiPolicyResult[];
}

export interface PublicationSnapshot {
  schemaVersion: 1;
  scope: string;
  revision: number;
  policyVersion: string;
  publishedAt: string;
  submissions: SerializedSubmission[];
  policy: {
    version: string;
    minCoveragePermille: number;
    aiResults: AiPolicyResult[];
  };
}

/**
 * Build the immutable snapshot object stored with a publication. It is a fully
 * self-contained copy of the published submissions and the policy verdict, so
 * later source-block revisions can never rewrite published history.
 */
export function buildSnapshot(input: SnapshotInput): PublicationSnapshot {
  return {
    schemaVersion: 1,
    scope: input.scope,
    revision: input.revision,
    policyVersion: input.policyVersion,
    publishedAt: input.publishedAt.toISOString(),
    submissions: input.submissions,
    policy: {
      version: input.policyVersion,
      minCoveragePermille: V1_MIN_COVERAGE_PERMILLE,
      aiResults: input.aiResults,
    },
  };
}

export function parseSnapshot(stored: string): PublicationSnapshot {
  return JSON.parse(stored) as PublicationSnapshot;
}

export interface SerializedPublication {
  id: string;
  scope: string;
  revision: number;
  policyVersion: string;
  createdAt: string;
  snapshot?: PublicationSnapshot;
}

/**
 * Serialize a publication row. List endpoints omit the (potentially large)
 * snapshot; the single-item endpoint includes it.
 */
export function serializePublication(
  publication: Publication,
  snapshot?: PublicationSnapshot,
): SerializedPublication {
  return {
    id: publication.id,
    scope: publication.scope,
    revision: publication.revision,
    policyVersion: publication.policyVersion,
    createdAt: publication.createdAt.toISOString(),
    ...(snapshot ? { snapshot } : {}),
  };
}
