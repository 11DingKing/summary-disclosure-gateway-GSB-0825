import { Prisma } from '@prisma/client';

export function isDatabaseBusyError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      return true;
    }
    if (error.code === 'P2002') {
      return true;
    }
  }
  const message = String((error as Error | null)?.message ?? '');
  return (
    message.includes('database is locked') ||
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED') ||
    message.includes('database table is locked')
  );
}

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
