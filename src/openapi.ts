/**
 * Hand-authored OpenAPI 3.1 document served at /v1/openapi.json and rendered by
 * @fastify/swagger-ui at /docs. It is the contract for the whole gateway.
 */
export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Summary Disclosure Gateway",
    version: "1.0.0",
    description: [
      'A "source gate" for reading products. Four content kinds are kept strictly apart:',
      "SOURCE_EXCERPT (original excerpts, with version + page numbers),",
      "READER_NOTE (reader notes), EDITOR_SUMMARY (editor summaries) and",
      "AI_SUMMARY (AI summaries, which MUST declare model metadata, input source block ids,",
      "generatedAt and per-claim CitationSpans).",
      "",
      "The gateway computes coveragePermille itself (deduped non-whitespace output characters",
      "covered by at least one valid citation, per mille, floored) and never trusts client values.",
      "Publishing under policy v1 requires every AI summary to reach coveragePermille >= 700 and",
      "every cited source hash to be valid; otherwise the API returns machine-readable rejection",
      "reasons. A successful publish stores an immutable Publication snapshot; later source",
      "revisions never rewrite history.",
    ].join("\n"),
  },
  tags: [
    { name: "submissions", description: "Content blocks of the four kinds" },
    {
      name: "publications",
      description: "Immutable, policy-gated publication snapshots",
    },
    { name: "meta", description: "Service metadata" },
  ],
  paths: {
    "/healthz": {
      get: {
        tags: ["meta"],
        summary: "Liveness probe",
        responses: {
          200: {
            description: "Service is up",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/v1/openapi.json": {
      get: {
        tags: ["meta"],
        summary: "This OpenAPI document",
        responses: { 200: { description: "OpenAPI document" } },
      },
    },
    "/v1/submissions": {
      post: {
        tags: ["submissions"],
        summary:
          "Create a submission (source excerpt, reader note, editor summary or AI summary)",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description:
              "Opaque key; replaying the same key with the same payload returns the stored response. Same key with a different payload yields 409 IDEMPOTENCY_KEY_REUSE.",
            schema: { type: "string", maxLength: 255 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateSubmissionRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Submission created (or idempotent replay)",
            headers: {
              "Idempotency-Replayed": {
                schema: { type: "string", enum: ["true", "false"] },
                description:
                  "true when the response was replayed from an idempotency record",
              },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Submission" },
              },
            },
          },
          400: { $ref: "#/components/responses/Error" },
          404: { $ref: "#/components/responses/Error" },
          409: { $ref: "#/components/responses/Error" },
        },
      },
      get: {
        tags: ["submissions"],
        summary:
          "List submissions (cursor pagination, stable (createdAt, id) ordering)",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            description: "Opaque nextCursor value from a previous page",
            schema: { type: "string" },
          },
          {
            name: "kind",
            in: "query",
            required: false,
            schema: { $ref: "#/components/schemas/SubmissionKind" },
          },
          {
            name: "docKey",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description:
              "Page of submissions ordered by (createdAt ASC, id ASC)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "nextCursor", "limit", "hasMore"],
                  properties: {
                    items: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Submission" },
                    },
                    nextCursor: { type: ["string", "null"] },
                    limit: { type: "integer" },
                    hasMore: { type: "boolean" },
                  },
                },
              },
            },
          },
          400: { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/submissions/{id}": {
      get: {
        tags: ["submissions"],
        summary: "Fetch a single submission",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Submission",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Submission" },
              },
            },
          },
          404: { $ref: "#/components/responses/Error" },
        },
      },
      patch: {
        tags: ["submissions"],
        summary:
          "Revise a SOURCE_EXCERPT (new version; recomputes contentHash). Other kinds are immutable and return 409.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version"],
                properties: {
                  version: {
                    type: "string",
                    minLength: 1,
                    maxLength: 64,
                    description:
                      "New source version; must differ from the current version",
                  },
                  body: { type: "string", minLength: 1 },
                  pageStart: { type: "integer", minimum: 1 },
                  pageEnd: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description:
              "Revised source excerpt with incremented sourceRevision and fresh contentHash",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Submission" },
              },
            },
          },
          400: { $ref: "#/components/responses/Error" },
          404: { $ref: "#/components/responses/Error" },
          409: { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/publications": {
      post: {
        tags: ["publications"],
        summary: "Publish an immutable snapshot under a disclosure policy",
        description: [
          'policyVersion selects the policy (only "v1" is supported). expectedRevision is the',
          "latest revision known to the client for the scope (0 for the first publish); a mismatch",
          "returns 409 REVISION_CONFLICT. Policy v1 rejects the publish (422 POLICY_VIOLATION with",
          "machine-readable reasons) unless every AI_SUMMARY reaches coveragePermille >= 700 and",
          "every citation hash still matches its source block.",
        ].join(" "),
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 255 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreatePublicationRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Publication snapshot created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Publication" },
              },
            },
          },
          400: { $ref: "#/components/responses/Error" },
          404: { $ref: "#/components/responses/Error" },
          409: { $ref: "#/components/responses/Error" },
          422: { $ref: "#/components/responses/Error" },
        },
      },
      get: {
        tags: ["publications"],
        summary:
          "List publications (cursor pagination, stable (createdAt, id) ordering)",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "scope",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description:
              "Page of publication metadata ordered by (createdAt ASC, id ASC)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "nextCursor", "limit", "hasMore"],
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        $ref: "#/components/schemas/PublicationSummary",
                      },
                    },
                    nextCursor: { type: ["string", "null"] },
                    limit: { type: "integer" },
                    hasMore: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/publications/{id}": {
      get: {
        tags: ["publications"],
        summary: "Fetch a publication including its immutable snapshot",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Publication with snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Publication" },
              },
            },
          },
          404: { $ref: "#/components/responses/Error" },
        },
      },
    },
  },
  components: {
    responses: {
      Error: {
        description: "Machine-readable error",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: {
                error: {
                  type: "object",
                  required: ["code", "message"],
                  properties: {
                    code: {
                      type: "string",
                      description:
                        "VALIDATION_ERROR | NOT_FOUND | RESOURCE_CONFLICT | IDEMPOTENCY_KEY_REUSE | IDEMPOTENCY_REQUEST_IN_PROGRESS | IMMUTABLE_SUBMISSION | VERSION_MUST_ADVANCE | UNSUPPORTED_POLICY_VERSION | REVISION_CONFLICT | SOURCE_BLOCK_NOT_FOUND | SUBMISSION_NOT_FOUND | POLICY_VIOLATION | INTERNAL_ERROR",
                    },
                    message: { type: "string" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    schemas: {
      SubmissionKind: {
        type: "string",
        enum: ["SOURCE_EXCERPT", "READER_NOTE", "EDITOR_SUMMARY", "AI_SUMMARY"],
      },
      CitationSpan: {
        type: "object",
        required: ["sourceBlockId", "outputStart", "outputEnd"],
        description:
          "A citation binding an AI-summary output span to a source block. Offsets are Unicode code points. sourceContentHash is recorded by the server and ignored if sent by the client.",
        properties: {
          sourceBlockId: { type: "string" },
          outputStart: {
            type: "integer",
            minimum: 0,
            description:
              "Inclusive start offset in the AI summary body (code points)",
          },
          outputEnd: {
            type: "integer",
            minimum: 1,
            description:
              "Exclusive end offset in the AI summary body (code points)",
          },
          sourceStart: {
            type: "integer",
            minimum: 0,
            description:
              "Optional inclusive start offset in the source body (code points)",
          },
          sourceEnd: {
            type: "integer",
            minimum: 1,
            description:
              "Optional exclusive end offset in the source body (code points)",
          },
        },
      },
      StoredCitation: {
        allOf: [
          { $ref: "#/components/schemas/CitationSpan" },
          {
            type: "object",
            required: ["id", "sourceContentHash", "ordinal"],
            properties: {
              id: { type: "string" },
              sourceContentHash: {
                type: "string",
                description:
                  "SHA-256 of the source block as it existed when the AI summary was created",
              },
              ordinal: { type: "integer" },
            },
          },
        ],
      },
      CreateSubmissionRequest: {
        type: "object",
        required: ["kind", "body"],
        properties: {
          kind: { $ref: "#/components/schemas/SubmissionKind" },
          body: {
            type: "string",
            minLength: 1,
            description:
              "Text content. Client-supplied contentHash/coveragePermille/sourceContentHash are always ignored.",
          },
          docKey: { type: "string" },
          version: {
            type: "string",
            description: "REQUIRED for SOURCE_EXCERPT",
          },
          pageStart: {
            type: "integer",
            minimum: 1,
            description: "REQUIRED for SOURCE_EXCERPT",
          },
          pageEnd: {
            type: "integer",
            minimum: 1,
            description: "REQUIRED for SOURCE_EXCERPT",
          },
          modelProvider: {
            type: "string",
            description: "REQUIRED for AI_SUMMARY",
          },
          modelName: { type: "string", description: "REQUIRED for AI_SUMMARY" },
          generatedAt: {
            type: "string",
            format: "date-time",
            description: "REQUIRED for AI_SUMMARY",
          },
          inputBlockIds: {
            type: "array",
            items: { type: "string" },
            description:
              "REQUIRED for AI_SUMMARY: ids of the SOURCE_EXCERPT blocks fed to the model",
          },
          citations: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/CitationSpan" },
            description:
              "REQUIRED for AI_SUMMARY: per-span citations into the output text",
          },
        },
      },
      Submission: {
        type: "object",
        required: ["id", "kind", "body", "createdAt", "updatedAt", "citations"],
        properties: {
          id: { type: "string" },
          kind: { $ref: "#/components/schemas/SubmissionKind" },
          docKey: { type: ["string", "null"] },
          body: { type: "string" },
          version: {
            type: ["string", "null"],
            description: "SOURCE_EXCERPT only",
          },
          pageStart: {
            type: ["integer", "null"],
            description: "SOURCE_EXCERPT only",
          },
          pageEnd: {
            type: ["integer", "null"],
            description: "SOURCE_EXCERPT only",
          },
          sourceRevision: {
            type: "integer",
            description: "SOURCE_EXCERPT only; increments on each revision",
          },
          contentHash: {
            type: ["string", "null"],
            description: "Server-computed SHA-256 for SOURCE_EXCERPT",
          },
          modelProvider: {
            type: ["string", "null"],
            description: "AI_SUMMARY only",
          },
          modelName: {
            type: ["string", "null"],
            description: "AI_SUMMARY only",
          },
          generatedAt: {
            type: ["string", "null"],
            format: "date-time",
            description: "AI_SUMMARY only",
          },
          inputBlockIds: {
            type: "array",
            items: { type: "string" },
            description: "AI_SUMMARY only",
          },
          citations: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredCitation" },
          },
          coveragePermille: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: 1000,
            description:
              "AI_SUMMARY only; computed live by the gateway: deduped non-whitespace output characters covered by at least one currently-valid citation, per mille, floored. Never derived from client input.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CreatePublicationRequest: {
        type: "object",
        required: ["policyVersion", "expectedRevision", "submissionIds"],
        properties: {
          scope: {
            type: "string",
            default: "default",
            description:
              "Publication scope (e.g. a document key); revisions are per scope",
          },
          policyVersion: { type: "string", enum: ["v1"] },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description:
              "Latest revision the client knows for the scope (0 for the first publish)",
          },
          submissionIds: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
        },
      },
      PublicationSummary: {
        type: "object",
        required: ["id", "scope", "revision", "policyVersion", "createdAt"],
        properties: {
          id: { type: "string" },
          scope: { type: "string" },
          revision: { type: "integer" },
          policyVersion: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      PublicationSnapshot: {
        type: "object",
        description:
          "Immutable point-in-time copy. Source blocks revised after publication never alter this object.",
        required: [
          "schemaVersion",
          "scope",
          "revision",
          "policyVersion",
          "publishedAt",
          "submissions",
          "policy",
        ],
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          scope: { type: "string" },
          revision: { type: "integer" },
          policyVersion: { type: "string" },
          publishedAt: { type: "string", format: "date-time" },
          submissions: {
            type: "array",
            items: { $ref: "#/components/schemas/Submission" },
          },
          policy: {
            type: "object",
            properties: {
              version: { type: "string" },
              minCoveragePermille: { type: "integer", example: 700 },
              aiResults: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    submissionId: { type: "string" },
                    coveragePermille: { type: "integer" },
                    coveredNonWhitespace: { type: "integer" },
                    totalNonWhitespace: { type: "integer" },
                    validCitationCount: { type: "integer" },
                    invalidCitationCount: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      Publication: {
        allOf: [
          { $ref: "#/components/schemas/PublicationSummary" },
          {
            type: "object",
            required: ["snapshot"],
            properties: {
              snapshot: { $ref: "#/components/schemas/PublicationSnapshot" },
            },
          },
        ],
      },
    },
  },
} as const;
