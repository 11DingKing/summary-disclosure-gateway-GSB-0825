import type { Publication } from '@prisma/client';
import { V1_MIN_COVERAGE_PERMILLE, type PolicyAiResult } from './policy.js';

export interface PublicationSnapshot {
  schemaVersion: 1;
  scope: string;
  revision: number;
  policyVersion: string;
  publishedAt: string;
  submissions: Record<string, unknown>[];
  policy: {
    version: string;
    minCoveragePermille: number;
    aiResults: PolicyAiResult[];
  };
}

export function buildSnapshot(input: {
  scope: string;
  revision: number;
  policyVersion: string;
  publishedAt: Date;
  submissions: Record<string, unknown>[];
  aiResults: PolicyAiResult[];
}): PublicationSnapshot {
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

export function serializePublication(
  publication: Publication,
  snapshot?: PublicationSnapshot,
): Record<string, unknown> {
  return {
    id: publication.id,
    scope: publication.scope,
    revision: publication.revision,
    policyVersion: publication.policyVersion,
    createdAt: publication.createdAt.toISOString(),
    ...(snapshot ? { snapshot } : {}),
  };
}
