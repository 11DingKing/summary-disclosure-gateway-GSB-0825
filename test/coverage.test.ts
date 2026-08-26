import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverage, codePointLength } from '../src/lib/coverage.js';
import { sourceContentHash } from '../src/lib/hash.js';
import { encodeCursor, decodeCursor } from '../src/lib/cursor.js';

test('Unicode: astral code points are indexed once (not UTF-16 code units)', () => {
  const body = '😀 😀 😀';
  assert.equal(codePointLength(body), 5);

  const single = computeCoverage(body, [{ outputStart: 0, outputEnd: 1, valid: true }]);
  assert.equal(single.totalNonWhitespace, 3);
  assert.equal(single.coveredNonWhitespace, 1);
  assert.equal(single.coveragePermille, Math.floor((1 * 1000) / 3));

  const full = computeCoverage(body, [{ outputStart: 0, outputEnd: 5, valid: true }]);
  assert.equal(full.coveredNonWhitespace, 3);
  assert.equal(full.coveragePermille, 1000);
});

test('Unicode: CJK text and ideographic space U+3000 are handled per code point', () => {
  const body = '概要\u3000の引用';
  assert.equal(codePointLength(body), 6);

  const all = computeCoverage(body, [{ outputStart: 0, outputEnd: 6, valid: true }]);
  assert.equal(all.totalNonWhitespace, 5);
  assert.equal(all.coveredNonWhitespace, 5);
  assert.equal(all.coveragePermille, 1000);

  const prefix = computeCoverage(body, [{ outputStart: 0, outputEnd: 3, valid: true }]);
  assert.equal(prefix.totalNonWhitespace, 5);
  assert.equal(prefix.coveredNonWhitespace, 2);
  assert.equal(prefix.coveragePermille, 400);
});

test('Overlapping citations: covered characters are deduplicated', () => {
  const body = 'aaaa bbbb';
  assert.equal(codePointLength(body), 9);

  const result = computeCoverage(body, [
    { outputStart: 0, outputEnd: 5, valid: true },
    { outputStart: 4, outputEnd: 9, valid: true },
  ]);

  assert.equal(result.totalNonWhitespace, 8);
  assert.equal(result.coveredNonWhitespace, 8);
  assert.equal(result.coveragePermille, 1000);
});

test('Overlapping citations: nested spans do not double count', () => {
  const body = 'abcdefghij';
  const result = computeCoverage(body, [
    { outputStart: 0, outputEnd: 10, valid: true },
    { outputStart: 2, outputEnd: 8, valid: true },
    { outputStart: 0, outputEnd: 3, valid: true },
  ]);
  assert.equal(result.coveredNonWhitespace, 10);
  assert.equal(result.coveragePermille, 1000);
});

test('Invalid citations cover nothing', () => {
  const body = 'abcdefghij';
  const result = computeCoverage(body, [
    { outputStart: 0, outputEnd: 10, valid: false },
    { outputStart: 0, outputEnd: 5, valid: false },
  ]);
  assert.equal(result.coveredNonWhitespace, 0);
  assert.equal(result.coveragePermille, 0);
});

test('coveragePermille is floored, never rounded up', () => {
  const body = 'abc';
  const oneThird = computeCoverage(body, [{ outputStart: 0, outputEnd: 1, valid: true }]);
  assert.equal(oneThird.coveredNonWhitespace, 1);
  assert.equal(oneThird.coveragePermille, 333);

  const twoThirds = computeCoverage(body, [{ outputStart: 0, outputEnd: 2, valid: true }]);
  assert.equal(twoThirds.coveragePermille, 666);
});

test('Whitespace-only or empty output reports zero coverage', () => {
  assert.equal(computeCoverage('   \n\t', [{ outputStart: 0, outputEnd: 5, valid: true }]).coveragePermille, 0);
  assert.equal(computeCoverage('', []).coveragePermille, 0);
});

test('Spans outside the body are clamped instead of covering extras', () => {
  const body = 'abcde';
  const result = computeCoverage(body, [
    { outputStart: -100, outputEnd: 100, valid: true },
  ]);
  assert.equal(result.coveredNonWhitespace, 5);
  assert.equal(result.coveragePermille, 1000);
});

test('sourceContentHash is stable for identical inputs and sensitive to every field', () => {
  const base = {
    version: '1.0.0',
    sourceRevision: 1,
    pageStart: 10,
    pageEnd: 11,
    body: 'canonical body',
  };

  const h = sourceContentHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(sourceContentHash(base), h);

  assert.notEqual(sourceContentHash({ ...base, version: '1.0.1' }), h);
  assert.notEqual(sourceContentHash({ ...base, sourceRevision: 2 }), h);
  assert.notEqual(sourceContentHash({ ...base, pageEnd: 12 }), h);
  assert.notEqual(sourceContentHash({ ...base, body: 'canonical body.' }), h);
});

test('sourceContentHash does not collide across NUL-delimited field reshuffles', () => {
  const a = sourceContentHash({
    version: 'ab',
    sourceRevision: 1,
    pageStart: 1,
    pageEnd: 1,
    body: 'cdef',
  });
  const b = sourceContentHash({
    version: 'a',
    sourceRevision: 1,
    pageStart: 1,
    pageEnd: 1,
    body: 'bcdef',
  });
  assert.notEqual(a, b);
});

test('Cursor encodes and decodes createdAt+id round trip', () => {
  const cursor = { createdAt: '2026-08-25T09:00:00.000Z', id: 'cuid-123' };
  const encoded = encodeCursor(cursor);
  assert.equal(typeof encoded, 'string');
  assert.deepEqual(decodeCursor(encoded), cursor);
});

test('Malformed cursors are rejected', () => {
  assert.throws(() => decodeCursor('not-base64-json!!!'), /Invalid pagination cursor/);
  assert.throws(() => decodeCursor(Buffer.from('["not-a-date","x"]').toString('base64url')), /Invalid pagination cursor/);
});
