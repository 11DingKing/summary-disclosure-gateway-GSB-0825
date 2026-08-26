/** Opaque cursor for stable (createdAt, id) ascending pagination. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString(
    "base64url",
  );
}

export function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ts, id] = parsed as [unknown, unknown];
    const createdAt = new Date(ts as string);
    if (
      typeof ts !== "string" ||
      Number.isNaN(createdAt.getTime()) ||
      typeof id !== "string"
    )
      return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
