import { createHash } from 'node:crypto';

const CANONICAL_DELIMITER = String.fromCharCode(0);

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface SourceHashInput {
  version: string;
  sourceRevision: number;
  pageStart: number;
  pageEnd: number;
  body: string;
}

export function sourceContentHash(input: SourceHashInput): string {
  const canonical = [
    'SOURCE_EXCERPT',
    input.version,
    `rev${input.sourceRevision}`,
    `p${input.pageStart}-${input.pageEnd}`,
    input.body,
  ].join(CANONICAL_DELIMITER);
  return sha256(canonical);
}
