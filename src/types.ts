import type { Kind } from "./constants.js";

export interface CitationSpanInput {
  sourceBlockId: string;
  startOffset: number;
  endOffset: number;
}

export interface CitationSpanRecord extends CitationSpanInput {
  id: string;
  submissionId: string;
  citedHash: string;
  createdAt: string;
}

export interface CreateSubmissionBody {
  kind: Kind;
  content: string;
  version?: string;
  page?: string;
  modelProvider?: string;
  modelName?: string;
  generatedAt?: string;
  inputSourceBlockIds?: string[];
  citations?: CitationSpanInput[];
}

export interface UpdateSubmissionBody {
  content: string;
}

export interface PublishBody {
  policyVersion: number;
  expectedRevision: number;
}

export interface SubmissionDto {
  id: string;
  kind: Kind;
  content: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  version?: string;
  page?: string;
  contentHash?: string;
  modelProvider?: string;
  modelName?: string;
  generatedAt?: string;
  inputSourceBlockIds?: string[];
  citations?: CitationSpanRecord[];
  coveragePermille?: number;
}

export interface PublicationSnapshot {
  publishedAt: string;
  policyVersion: number;
  revision: number;
  coveragePermille: number;
  sourceHashesValid: boolean;
  submission: {
    id: string;
    kind: Kind;
    content: string;
    version: string | null;
    page: string | null;
    contentHash: string | null;
    modelProvider: string | null;
    modelName: string | null;
    generatedAt: string | null;
    inputSourceBlockIds: string[];
    revision: number;
    createdAt: string;
    updatedAt: string;
  };
  citations: Array<{
    id: string;
    sourceBlockId: string;
    startOffset: number;
    endOffset: number;
    citedHash: string;
    sourceBlockContent: string | null;
    sourceBlockVersion: string | null;
    sourceBlockPage: string | null;
    sourceBlockHash: string | null;
  }>;
}

export interface PublicationDto {
  id: string;
  submissionId: string;
  policyVersion: number;
  revision: number;
  coveragePermille: number;
  sourceHashesValid: boolean;
  publishedAt: string;
  snapshot: PublicationSnapshot;
}
