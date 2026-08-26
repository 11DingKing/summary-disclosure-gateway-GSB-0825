import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from './errors.js';
import { sha256 } from './hash.js';
import { withBusyRetry } from './concurrency.js';

export interface IdempotencyOutcome {
  replay: boolean;
  statusCode: number;
  body: unknown;
}

const STATUS_PENDING = 'PENDING';
const STATUS_COMPLETED = 'COMPLETED';

const POLL_INTERVAL_MS = 20;
const POLL_TIMEOUT_MS = 15_000;

const RESERVATION_RELEASED = 'RESERVATION_RELEASED' as const;

export function idempotencyKeyFromHeaders(headers: Record<string, unknown>): string | undefined {
  const raw = headers['idempotency-key'];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const key = raw.trim();
  if (!key) {
    return undefined;
  }
  if (key.length > 255) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must not exceed 255 characters',
      { field: 'Idempotency-Key' },
    );
  }
  return key;
}

export async function withIdempotency(
  db: PrismaClient,
  scope: string,
  key: string | undefined,
  fingerprintInput: unknown,
  fn: () => Promise<{ statusCode: number; body: unknown }>,
): Promise<IdempotencyOutcome> {
  if (!key) {
    const result = await fn();
    return { replay: false, statusCode: result.statusCode, body: result.body };
  }

  const fullKey = `${scope}:${key}`;
  const requestHash = sha256(JSON.stringify(fingerprintInput) ?? '');

  for (;;) {
    // Atomically reserve the key before any side effect runs. The primary-key
    // unique constraint guarantees that among concurrent identical requests at
    // most one caller wins the reservation; only that caller executes fn(), so
    // the creation happens exactly once.
    try {
      await reserveKey(db, fullKey, requestHash);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const waited = await waitForReservation(db, fullKey, key, requestHash);
        if (waited === RESERVATION_RELEASED) {
          continue;
        }
        return waited;
      }
      throw error;
    }
    break;
  }

  try {
    const result = await fn();
    await withBusyRetry(() =>
      db.idempotencyRecord.update({
        where: { key: fullKey },
        data: {
          status: STATUS_COMPLETED,
          statusCode: result.statusCode,
          body: JSON.stringify(result.body),
        },
      }),
    );
    return { replay: false, statusCode: result.statusCode, body: result.body };
  } catch (error) {
    // The reservation holder failed: release the key so a retry with the same
    // key can run. Side effects of every creation endpoint are atomic
    // (single create or $transaction), so no partial result leaks.
    await withBusyRetry(() => db.idempotencyRecord.delete({ where: { key: fullKey } })).catch(
      () => undefined,
    );
    throw error;
  }
}

async function reserveKey(
  db: PrismaClient,
  fullKey: string,
  requestHash: string,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await db.idempotencyRecord.create({
        data: {
          key: fullKey,
          requestHash,
          status: STATUS_PENDING,
          statusCode: 0,
          body: '',
        },
      });
      return;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw error;
      }
      if (!isTransientBusy(error) || attempt >= 19) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 20 + attempt * 20 + Math.floor(Math.random() * 20)),
      );
      attempt += 1;
    }
  }
}

async function waitForReservation(
  db: PrismaClient,
  fullKey: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyOutcome | typeof RESERVATION_RELEASED> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const record = await db.idempotencyRecord.findUnique({ where: { key: fullKey } });
    if (!record) {
      return RESERVATION_RELEASED;
    }
    if (record.requestHash !== requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSE',
        'The Idempotency-Key was already used with a different request payload',
        { idempotencyKey: key },
      );
    }
    if (record.status === STATUS_COMPLETED) {
      return {
        replay: true,
        statusCode: record.statusCode,
        body: JSON.parse(record.body) as unknown,
      };
    }
    if (Date.now() >= deadline) {
      throw new AppError(
        409,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'A request with this Idempotency-Key is still being processed; retry later',
        { idempotencyKey: key },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function isTransientBusy(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
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
