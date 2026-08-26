export const SOURCE_EXCERPT = "SOURCE_EXCERPT";
export const READER_NOTE = "READER_NOTE";
export const EDITOR_SUMMARY = "EDITOR_SUMMARY";
export const AI_SUMMARY = "AI_SUMMARY";

export const KINDS = [
  SOURCE_EXCERPT,
  READER_NOTE,
  EDITOR_SUMMARY,
  AI_SUMMARY,
] as const;

export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

export const POLICY_V1 = 1;
export const POLICY_V1_MIN_COVERAGE_PERMILLE = 700;
export const COVERAGE_PERMILLE_MAX = 1000;
