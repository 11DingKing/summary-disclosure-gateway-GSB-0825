import { describe, it, expect } from "vitest";
import { computeCoveragePermille, spanInBounds } from "../src/lib/coverage";

describe("computeCoveragePermille", () => {
  it("computes partial ASCII coverage", () => {
    // "hello world": 10 non-ws chars, "hello" covered -> 500
    expect(computeCoveragePermille("hello world", [{ start: 0, end: 5 }])).toBe(
      500,
    );
  });

  it("counts Unicode code points, not UTF-16 units (emoji + CJK)", () => {
    // 5 code points: 摘 要 😀 很 好 — all non-whitespace
    expect(computeCoveragePermille("摘要😀很好", [{ start: 0, end: 3 }])).toBe(
      600,
    );
    expect(computeCoveragePermille("摘要😀很好", [{ start: 0, end: 5 }])).toBe(
      1000,
    );
    // the emoji alone is exactly one code point
    expect(computeCoveragePermille("摘要😀很好", [{ start: 2, end: 3 }])).toBe(
      200,
    );
  });

  it("de-duplicates overlapping spans", () => {
    // union of [0,4) and [2,6) is 6 chars of 8, not 4+4
    expect(
      computeCoveragePermille("abcdefgh", [
        { start: 0, end: 4 },
        { start: 2, end: 6 },
      ]),
    ).toBe(750);
    // fully duplicated spans must not inflate coverage
    expect(
      computeCoveragePermille("abcdefgh", [
        { start: 0, end: 8 },
        { start: 0, end: 8 },
      ]),
    ).toBe(1000);
  });

  it("excludes whitespace from numerator and denominator", () => {
    expect(computeCoveragePermille("a b", [{ start: 0, end: 3 }])).toBe(1000);
    // [0,2) covers "a" + the space -> only 1 of 2 non-ws chars
    expect(computeCoveragePermille("a b", [{ start: 0, end: 2 }])).toBe(500);
  });

  it("returns 0 for empty or whitespace-only text", () => {
    expect(computeCoveragePermille("", [])).toBe(0);
    expect(computeCoveragePermille("   ", [{ start: 0, end: 3 }])).toBe(0);
  });

  it("floors to integer permille", () => {
    expect(computeCoveragePermille("abc", [{ start: 0, end: 1 }])).toBe(333);
  });
});

describe("spanInBounds", () => {
  it("accepts code-point ranges within the text", () => {
    expect(spanInBounds({ start: 0, end: 5 }, "摘要😀很好")).toBe(true);
    expect(spanInBounds({ start: 0, end: 6 }, "摘要😀很好")).toBe(false);
    expect(spanInBounds({ start: 2, end: 2 }, "摘要😀很好")).toBe(false);
    expect(spanInBounds({ start: -1, end: 2 }, "摘要😀很好")).toBe(false);
  });
});
