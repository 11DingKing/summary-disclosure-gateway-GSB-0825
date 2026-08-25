import { validationError } from './errors.js';

export interface PageCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(encoded: string): PageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw validationError('Invalid pagination cursor', { field: 'cursor' });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string'
  ) {
    throw validationError('Invalid pagination cursor', { field: 'cursor' });
  }
  const createdAt = new Date(parsed[0]);
  if (Number.isNaN(createdAt.getTime())) {
    throw validationError('Invalid pagination cursor', { field: 'cursor' });
  }
  return { createdAt: parsed[0], id: parsed[1] };
}

export function parseLimit(value: unknown, defaultValue = 20, max = 100): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw validationError(`limit must be an integer between 1 and ${max}`, {
      field: 'limit',
      max,
    });
  }
  return n;
}
