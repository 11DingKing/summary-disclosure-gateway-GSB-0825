import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiSummary,
  createSourceExcerpt,
  fullCoverageCitations,
  setupHarness,
} from './helpers.js';
import { codePointLength } from '../src/lib/unicode.js';

test('Unicode coverage and code-point offsets', async (t) => {
  const harness = await setupHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const source = await createSourceExcerpt(
    harness.app,
    'Source material used for citation purposes.',
    { version: '1.0', page: '1' },
  );
  assert.equal(source.status, 201);
  const sourceId = source.body.id;

  await t.test('counts emoji/astral characters as single code points', async () => {
    // "😀" is 1 code point but 2 UTF-16 code units.
    const content = '😀 Hello café';
    const codePoints = Array.from(content);
    assert.equal(codePointLength(content), codePoints.length);
    assert.equal(content.length, codePoints.length + 1, 'UTF-16 length differs from code-point length');

    const citations = fullCoverageCitations(content, sourceId);
    const res = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.coveragePermille, 1000);
    assert.equal(res.body.citations.length, 1);
    assert.equal(res.body.citations[0].endOffset, codePoints.length);
  });

  await t.test('rejects UTF-16 length offsets that exceed code-point length', async () => {
    const content = '😀 Hello';
    const utf16Length = content.length; // 8 (emoji counts as 2)
    const cpLength = codePointLength(content); // 7
    assert.ok(utf16Length > cpLength);

    const res = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [
        { sourceBlockId: sourceId, startOffset: 0, endOffset: utf16Length },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'CITATION_OFFSET_OUT_OF_BOUNDS');
    assert.equal(res.body.error.details.length, cpLength);
  });

  await t.test('ignores whitespace in the coverage denominator', async () => {
    // 10 non-whitespace code points: A B C D E F G H I J
    const content = 'AB\tCD EF\nGH IJ';
    const length = codePointLength(content);
    // Cover [0, length) entirely -> every non-whitespace char covered.
    const full = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [{ sourceBlockId: sourceId, startOffset: 0, endOffset: length }],
    });
    assert.equal(full.status, 201);
    assert.equal(full.body.coveragePermille, 1000);

    // Cover only "AB\tCD" (code points 0..4 -> A B \t C D). Non-ws covered = 4
    // (A,B,C,D); total non-ws = 10 -> 400 permille.
    const partial = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [{ sourceBlockId: sourceId, startOffset: 0, endOffset: 5 }],
    });
    assert.equal(partial.status, 201);
    assert.equal(partial.body.coveragePermille, 400);
  });

  await t.test('treats non-breaking spaces as whitespace too', async () => {
    // U+00A0 NO-BREAK SPACE is White_Space.
    const content = 'A\u00a0B\u00a0C';
    const length = codePointLength(content);
    const res = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [{ sourceBlockId: sourceId, startOffset: 0, endOffset: length }],
    });
    assert.equal(res.status, 201);
    // 3 non-whitespace code points all covered -> 1000 (the nbsp is not counted).
    assert.equal(res.body.coveragePermille, 1000);
  });
});
