export interface CoverageSpan {
  outputStart: number;
  outputEnd: number;
  valid: boolean;
}

export interface CoverageResult {
  coveragePermille: number;
  coveredNonWhitespace: number;
  totalNonWhitespace: number;
  codePointLength: number;
}

export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) {
    n += 1;
  }
  return n;
}

export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function isWhitespace(codePointChar: string): boolean {
  return /\s/u.test(codePointChar);
}

export function computeCoverage(output: string, spans: CoverageSpan[]): CoverageResult {
  const chars = codePoints(output);
  const covered = new Uint8Array(chars.length);

  for (const span of spans) {
    if (!span.valid) {
      continue;
    }
    const start = Math.max(0, Math.min(chars.length, Math.trunc(span.outputStart)));
    const end = Math.max(start, Math.min(chars.length, Math.trunc(span.outputEnd)));
    for (let i = start; i < end; i += 1) {
      covered[i] = 1;
    }
  }

  let totalNonWhitespace = 0;
  let coveredNonWhitespace = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    if (isWhitespace(ch)) {
      continue;
    }
    totalNonWhitespace += 1;
    if (covered[i] === 1) {
      coveredNonWhitespace += 1;
    }
  }

  const coveragePermille =
    totalNonWhitespace === 0
      ? 0
      : Math.min(1000, Math.floor((coveredNonWhitespace * 1000) / totalNonWhitespace));

  return {
    coveragePermille,
    coveredNonWhitespace,
    totalNonWhitespace,
    codePointLength: chars.length,
  };
}
