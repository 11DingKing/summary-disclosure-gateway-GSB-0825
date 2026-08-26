export const BLOCK_KINDS = [
  "SOURCE_EXCERPT",
  "READER_NOTE",
  "EDITOR_SUMMARY",
  "AI_SUMMARY",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Offsets are Unicode code-point indices into the summary text, end exclusive. */
export interface CitationSpan {
  start: number;
  end: number;
  sourceBlockId: string;
  sourceHash: string;
}
