/**
 * Opaque cursor pagination. Cursors encode `(createdAt, id)` so that ordering is
 * stable even when several rows share a timestamp. The cursor is base64url-
 * encoded JSON so clients cannot meaningfully tamper with it; an invalid cursor
 * is rejected with 400.
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(encoded: string): Cursor | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const obj = JSON.parse(json) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      typeof (obj as Cursor).createdAt === "string" &&
      typeof (obj as Cursor).id === "string"
    ) {
      return obj as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

export interface PageParams {
  limit: number;
  cursor: Cursor | null;
}

export function resolvePageParams(
  queryLimit: unknown,
  queryCursor: unknown,
  defaultLimit: number,
  maxLimit: number,
): PageParams {
  let limit = defaultLimit;
  if (queryLimit !== undefined && queryLimit !== "") {
    const parsed = Number(queryLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      limit = defaultLimit;
    } else {
      limit = Math.min(parsed, maxLimit);
    }
  }

  let cursor: Cursor | null = null;
  if (typeof queryCursor === "string" && queryCursor !== "") {
    cursor = decodeCursor(queryCursor);
    if (!cursor) {
      throw new InvalidCursorError();
    }
  }

  return { limit, cursor };
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid pagination cursor");
    this.name = "InvalidCursorError";
  }
}
