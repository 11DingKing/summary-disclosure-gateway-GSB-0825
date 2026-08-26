import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCoverage,
  codePointLength,
  type CoverageSpan,
} from "../src/lib/coverage.js";

test("codePointLength counts astral characters as one", () => {
  // Emoji and astral CJK are single code points but multiple UTF-16 units.
  assert.equal(codePointLength("a😀b"), 3);
  assert.equal("a😀b".length, 4); // UTF-16 length differs
  assert.equal(codePointLength("𠀀𠀁"), 2);
});

test("coverage counts Unicode code points, not UTF-16 units", () => {
  // Body: "😀ABCD" — 5 code points, all non-whitespace.
  const body = "😀ABCD";
  // Cover the emoji (0..1) and "AB" (1..3) => 3 of 5 covered.
  const spans: CoverageSpan[] = [
    { outputStart: 0, outputEnd: 1, valid: true },
    { outputStart: 1, outputEnd: 3, valid: true },
  ];
  const result = computeCoverage(body, spans);
  assert.equal(result.codePointLength, 5);
  assert.equal(result.totalNonWhitespace, 5);
  assert.equal(result.coveredNonWhitespace, 3);
  assert.equal(result.coveragePermille, 600);
});

test("overlapping spans are deduplicated (no double counting)", () => {
  const body = "ABCDEFGHIJ"; // 10 non-whitespace chars
  const spans: CoverageSpan[] = [
    { outputStart: 0, outputEnd: 5, valid: true },
    { outputStart: 3, outputEnd: 7, valid: true }, // overlaps 3..5
    { outputStart: 6, outputEnd: 8, valid: true }, // overlaps 6..7
  ];
  // Union of covered positions: 0..8 => 8 chars.
  const result = computeCoverage(body, spans);
  assert.equal(result.coveredNonWhitespace, 8);
  assert.equal(result.totalNonWhitespace, 10);
  assert.equal(result.coveragePermille, 800);
});

test("whitespace is excluded from numerator and denominator", () => {
  const body = "AB  CD"; // 4 non-whitespace, 2 spaces
  const spans: CoverageSpan[] = [
    { outputStart: 0, outputEnd: 2, valid: true }, // "AB"
    { outputStart: 2, outputEnd: 4, valid: true }, // the two spaces
  ];
  const result = computeCoverage(body, spans);
  // Only "AB" counts as covered non-whitespace; denominator is 4.
  assert.equal(result.totalNonWhitespace, 4);
  assert.equal(result.coveredNonWhitespace, 2);
  assert.equal(result.coveragePermille, 500);
});

test("invalid spans contribute nothing", () => {
  const body = "ABCDE";
  const spans: CoverageSpan[] = [
    { outputStart: 0, outputEnd: 3, valid: false },
    { outputStart: 3, outputEnd: 5, valid: true },
  ];
  const result = computeCoverage(body, spans);
  assert.equal(result.coveredNonWhitespace, 2);
  assert.equal(result.coveragePermille, 400);
});

test("coverage floors instead of rounding", () => {
  const body = "ABC"; // 3 chars
  const spans: CoverageSpan[] = [{ outputStart: 0, outputEnd: 2, valid: true }];
  // 2/3 = 666.66.. per mille -> floor 666.
  const result = computeCoverage(body, spans);
  assert.equal(result.coveragePermille, 666);
});

test("all-whitespace body yields zero coverage, not division by zero", () => {
  const result = computeCoverage("   \n\t", [
    { outputStart: 0, outputEnd: 3, valid: true },
  ]);
  assert.equal(result.totalNonWhitespace, 0);
  assert.equal(result.coveragePermille, 0);
});

test("combining marks count as separate code points", () => {
  // "e" + combining acute accent = 2 code points.
  const body = "e\u0301llo"; // é(decomposed) l l o -> 5 code points
  assert.equal(codePointLength(body), 5);
  const result = computeCoverage(body, [
    { outputStart: 0, outputEnd: 2, valid: true },
  ]);
  assert.equal(result.totalNonWhitespace, 5);
  assert.equal(result.coveredNonWhitespace, 2);
});
