import { Prisma } from "@prisma/client";

/**
 * SQLite serializes writes, so under concurrency a transaction can fail with a
 * transient "busy"/"locked" error or Prisma's P2034 write-conflict. These are
 * safe to retry: the losing writer simply tries again against fresh state.
 */
export function isDatabaseBusyError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") {
      return true;
    }
    if (error.code === "P2002") {
      return true;
    }
  }
  const message = String((error as { message?: unknown })?.message ?? "");
  return (
    message.includes("database is locked") ||
    message.includes("SQLITE_BUSY") ||
    message.includes("SQLITE_LOCKED") ||
    message.includes("database table is locked")
  );
}

/**
 * Run `fn`, retrying with jittered backoff while the failure is a transient
 * SQLite contention error. Non-transient errors propagate immediately.
 */
export async function withBusyRetry<T>(
  fn: (attempt: number) => Promise<T>,
  attempts = 15,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isDatabaseBusyError(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 30 + attempt * 30 + Math.floor(Math.random() * 30)),
      );
    }
  }
  throw lastError;
}
