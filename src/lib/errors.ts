export interface PolicyReason {
  code: 'INSUFFICIENT_COVERAGE' | 'SOURCE_HASH_MISMATCH' | 'SOURCE_BLOCK_NOT_FOUND';
  submissionId: string;
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function validationError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message, details);
}

export function notFound(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(404, 'NOT_FOUND', message, details);
}

export function conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, code, message, details);
}

export function policyViolation(policyVersion: string, reasons: PolicyReason[]): AppError {
  return new AppError(
    422,
    'POLICY_VIOLATION',
    'Publication rejected by the source-disclosure policy',
    { policyVersion, reasons },
  );
}
