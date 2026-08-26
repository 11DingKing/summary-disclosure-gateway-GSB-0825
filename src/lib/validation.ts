import { validationError } from "./errors.js";
import { codePointLength } from "./coverage.js";

export const KINDS = [
  "SOURCE_EXCERPT",
  "READER_NOTE",
  "EDITOR_SUMMARY",
  "AI_SUMMARY",
] as const;

export type SubmissionKind = (typeof KINDS)[number];

export function isKind(value: unknown): value is SubmissionKind {
  return (
    typeof value === "string" && (KINDS as readonly string[]).includes(value)
  );
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function requireNonEmptyString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 2000,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`"${field}" must be a non-empty string`, { field });
  }
  if (value.length > maxLength) {
    throw validationError(
      `"${field}" must not exceed ${maxLength} characters`,
      {
        field,
        maxLength,
      },
    );
  }
  return value;
}

export function optionalTrimmedString(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw validationError(`"${field}" must be a string`, { field });
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function requireBody(
  body: Record<string, unknown>,
  maxLength = 200_000,
): string {
  const value = body.body;
  if (typeof value !== "string" || value.length === 0) {
    throw validationError('"body" must be a non-empty string', {
      field: "body",
    });
  }
  if (value.length > maxLength) {
    throw validationError(`"body" must not exceed ${maxLength} characters`, {
      field: "body",
      maxLength,
    });
  }
  return value;
}

export function requireInteger(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw validationError(`"${field}" must be an integer`, { field });
  }
  return value;
}

export function parseDateField(
  body: Record<string, unknown>,
  field: string,
): Date {
  const value = body[field];
  if (typeof value !== "string") {
    throw validationError(`"${field}" must be an ISO-8601 date-time string`, {
      field,
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError(`"${field}" is not a valid date-time`, { field });
  }
  return date;
}

export function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw validationError(`"${field}" must be an array of strings`, { field });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw validationError(`"${field}" must contain only non-empty strings`, {
        field,
      });
    }
    out.push(item);
  }
  return out;
}

export interface PageRange {
  pageStart: number;
  pageEnd: number;
}

export function parsePageRange(body: Record<string, unknown>): PageRange {
  const pageStart = body.pageStart;
  const pageEnd = body.pageEnd;
  if (
    typeof pageStart !== "number" ||
    typeof pageEnd !== "number" ||
    !Number.isInteger(pageStart) ||
    !Number.isInteger(pageEnd)
  ) {
    throw validationError('"pageStart" and "pageEnd" must both be integers', {
      fields: ["pageStart", "pageEnd"],
    });
  }
  if (pageStart < 1 || pageEnd < 1) {
    throw validationError("page numbers must be >= 1", {
      fields: ["pageStart", "pageEnd"],
    });
  }
  if (pageStart > pageEnd) {
    throw validationError(
      '"pageStart" must be less than or equal to "pageEnd"',
      {
        fields: ["pageStart", "pageEnd"],
      },
    );
  }
  return { pageStart, pageEnd };
}

export interface CitationInput {
  sourceBlockId: string;
  outputStart: number;
  outputEnd: number;
  sourceStart: number | null;
  sourceEnd: number | null;
  ordinal: number;
}

/**
 * Validate a client-supplied `citations` array against the AI summary output
 * length (in code points) and, when a source span is provided, against the
 * referenced source block's length. Offsets are half-open [start, end) ranges
 * counted in Unicode code points. `ordinal` records the client's original order
 * so citations remain stably addressable after storage.
 */
export function parseCitationSpans(
  raw: unknown,
  outputCodePointLength: number,
  sourceCodePointLength: (sourceBlockId: string) => number | null,
): CitationInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError(
      '"citations" must be a non-empty array of CitationSpan objects',
      { field: "citations" },
    );
  }
  if (raw.length > 1000) {
    throw validationError('"citations" must not contain more than 1000 spans', {
      field: "citations",
    });
  }

  return raw.map((item, ordinal) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw validationError(`citations[${ordinal}] must be an object`, {
        ordinal,
      });
    }
    const citation = item as Record<string, unknown>;

    const sourceBlockId = citation.sourceBlockId;
    if (
      typeof sourceBlockId !== "string" ||
      sourceBlockId.trim().length === 0
    ) {
      throw validationError(
        `citations[${ordinal}].sourceBlockId must be a non-empty string`,
        { ordinal, field: "sourceBlockId" },
      );
    }

    const outputStart = citation.outputStart;
    const outputEnd = citation.outputEnd;
    if (
      typeof outputStart !== "number" ||
      typeof outputEnd !== "number" ||
      !Number.isInteger(outputStart) ||
      !Number.isInteger(outputEnd) ||
      outputStart < 0 ||
      outputEnd <= outputStart ||
      outputEnd > outputCodePointLength
    ) {
      throw validationError(
        `citations[${ordinal}].outputStart/outputEnd must satisfy 0 <= start < end <= body length in Unicode code points`,
        { ordinal, bodyCodePointLength: outputCodePointLength },
      );
    }

    let sourceStart: number | null = null;
    let sourceEnd: number | null = null;
    if (citation.sourceStart !== undefined && citation.sourceStart !== null) {
      const sourceLength = sourceCodePointLength(sourceBlockId);
      sourceStart = citation.sourceStart as number;
      sourceEnd = citation.sourceEnd as number;
      if (
        typeof citation.sourceStart !== "number" ||
        typeof citation.sourceEnd !== "number" ||
        !Number.isInteger(sourceStart) ||
        !Number.isInteger(sourceEnd) ||
        sourceLength === null ||
        sourceStart < 0 ||
        sourceEnd <= sourceStart ||
        sourceEnd > sourceLength
      ) {
        throw validationError(
          `citations[${ordinal}].sourceStart/sourceEnd must satisfy 0 <= start < end <= source body length in Unicode code points`,
          { ordinal, sourceBlockId, sourceCodePointLength: sourceLength },
        );
      }
    }

    return {
      sourceBlockId,
      outputStart,
      outputEnd,
      sourceStart,
      sourceEnd,
      ordinal,
    };
  });
}

/** Convenience re-export: assert/measure a string in Unicode code points. */
export function assertWithinCodePoints(text: string): number {
  return codePointLength(text);
}
