import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from './errors.js';
import { sha256 } from './hash.js';

export interface IdempotencyOutcome {
  replay: boolean;
  statusCode: number;
  body: unknown;
}

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

  const existing = await db.idempotencyRecord.findUnique({ where: { key: fullKey } });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSE',
        'The Idempotency-Key was already used with a different request payload',
        { idempotencyKey: key },
      );
    }
    return {
      replay: true,
      statusCode: existing.statusCode,
      body: JSON.parse(existing.body) as unknown,
    };
  }

  const result = await fn();

  try {
    await db.idempotencyRecord.create({
      data: {
        key: fullKey,
        requestHash,
        statusCode: result.statusCode,
        body: JSON.stringify(result.body),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const winner = await db.idempotencyRecord.findUnique({ where: { key: fullKey } });
      if (winner && winner.requestHash === requestHash) {
        return {
          replay: true,
          statusCode: winner.statusCode,
          body: JSON.parse(winner.body) as unknown,
        };
      }
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSE',
        'The Idempotency-Key was already used with a different request payload',
        { idempotencyKey: key },
      );
    }
    throw error;
  }

  return { replay: false, statusCode: result.statusCode, body: result.body };
}
