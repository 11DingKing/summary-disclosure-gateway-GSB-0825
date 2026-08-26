import { KINDS } from "../constants.js";

const citationSpanProps = {
  sourceBlockId: { type: "string", minLength: 1 },
  startOffset: { type: "integer", minimum: 0 },
  endOffset: { type: "integer", minimum: 1 },
} as const;

const citationSpanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceBlockId", "startOffset", "endOffset"],
  properties: citationSpanProps,
} as const;

export const createSubmissionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "content"],
  properties: {
    kind: { type: "string", enum: [...KINDS] },
    content: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    page: { type: "string", minLength: 1 },
    modelProvider: { type: "string", minLength: 1 },
    modelName: { type: "string", minLength: 1 },
    generatedAt: { type: "string", format: "date-time" },
    inputSourceBlockIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    citations: {
      type: "array",
      minItems: 1,
      items: citationSpanSchema,
    },
  },
  allOf: [
    {
      if: { properties: { kind: { const: "SOURCE_EXCERPT" } } },
      then: { required: ["version", "page"] },
    },
    {
      if: { properties: { kind: { const: "AI_SUMMARY" } } },
      then: {
        required: [
          "modelProvider",
          "modelName",
          "generatedAt",
          "inputSourceBlockIds",
          "citations",
        ],
      },
    },
  ],
} as const;

export const updateSubmissionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    content: { type: "string", minLength: 1 },
  },
} as const;

export const publishBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["policyVersion", "expectedRevision"],
  properties: {
    policyVersion: { type: "integer", minimum: 1 },
    expectedRevision: { type: "integer", minimum: 1 },
  },
} as const;

export const idempotencyHeaderSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

export const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string" },
    kind: { type: "string", enum: [...KINDS] },
  },
} as const;

export const publicationListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string" },
  },
} as const;

export const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
    },
  },
} as const;

const citationSpanDtoProps = {
  id: { type: "string" },
  submissionId: { type: "string" },
  sourceBlockId: { type: "string" },
  startOffset: { type: "integer" },
  endOffset: { type: "integer" },
  citedHash: { type: "string" },
  createdAt: { type: "string", format: "date-time" },
} as const;

export const submissionDtoSchema = {
  type: "object",
  required: ["id", "kind", "content", "revision", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: [...KINDS] },
    content: { type: "string" },
    revision: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    version: { type: "string" },
    page: { type: "string" },
    contentHash: { type: "string" },
    modelProvider: { type: "string" },
    modelName: { type: "string" },
    generatedAt: { type: "string", format: "date-time" },
    inputSourceBlockIds: {
      type: "array",
      items: { type: "string" },
    },
    coveragePermille: { type: "integer" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: citationSpanDtoProps,
      },
    },
  },
} as const;

export const publicationDtoSchema = {
  type: "object",
  required: [
    "id",
    "submissionId",
    "policyVersion",
    "revision",
    "coveragePermille",
    "sourceHashesValid",
    "publishedAt",
    "snapshot",
  ],
  properties: {
    id: { type: "string" },
    submissionId: { type: "string" },
    policyVersion: { type: "integer" },
    revision: { type: "integer" },
    coveragePermille: { type: "integer" },
    sourceHashesValid: { type: "boolean" },
    publishedAt: { type: "string", format: "date-time" },
    snapshot: { type: "object", additionalProperties: true },
  },
} as const;

export const listSubmissionsResponseSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: submissionDtoSchema },
    nextCursor: { type: "string", nullable: true },
  },
} as const;

export const listPublicationsResponseSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: publicationDtoSchema },
    nextCursor: { type: "string", nullable: true },
  },
} as const;
