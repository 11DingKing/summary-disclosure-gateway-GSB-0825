import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiSummary,
  createSourceExcerpt,
  getSubmission,
  patchSubmission,
  setupHarness,
} from './helpers.js';
import { codePointLength } from '../src/lib/unicode.js';

test('Overlapping citation coverage', async (t) => {
  const harness = await setupHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const source = await createSourceExcerpt(
    harness.app,
    'The quick brown fox jumps over the lazy dog.',
    { version: '1.0', page: '9' },
  );
  assert.equal(source.status, 201);
  const sourceId = source.body.id;

  await t.test('overlapping spans union and never double count', async () => {
    // "Hello world": 11 code points, 10 non-whitespace.
    const content = 'Hello world';
    assert.equal(codePointLength(content), 11);

    // Single span [0,6) = "Hello " covers 5 non-ws chars -> 500.
    const single = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [
        { sourceBlockId: sourceId, startOffset: 0, endOffset: 6 },
      ],
    });
    assert.equal(single.status, 201);
    assert.equal(single.body.coveragePermille, 500);

    // Add overlapping [4,11) = "o world". Union covers every non-ws char -> 1000.
    const overlapped = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [
        { sourceBlockId: sourceId, startOffset: 0, endOffset: 6 },
        { sourceBlockId: sourceId, startOffset: 4, endOffset: 11 },
      ],
    });
    assert.equal(overlapped.status, 201);
    assert.equal(overlapped.body.coveragePermille, 1000);

    // A third nested/duplicate span does not inflate coverage (still 1000, and
    // the covered char count is not 3x).
    const tripled = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [
        { sourceBlockId: sourceId, startOffset: 0, endOffset: 6 },
        { sourceBlockId: sourceId, startOffset: 4, endOffset: 11 },
        { sourceBlockId: sourceId, startOffset: 1, endOffset: 4 },
      ],
    });
    assert.equal(tripled.status, 201);
    assert.equal(tripled.body.coveragePermille, 1000);
  });

  await t.test('adjacent spans with no gap cover the whole output', async () => {
    const content = 'AlphaBetaGamma';
    const len = codePointLength(content);
    const res = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: [
        { sourceBlockId: sourceId, startOffset: 0, endOffset: 5 },
        { sourceBlockId: sourceId, startOffset: 5, endOffset: 10 },
        { sourceBlockId: sourceId, startOffset: 10, endOffset: len },
      ],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.coveragePermille, 1000);
  });

  await t.test('invalid citations are excluded from the union', async () => {
    const source2 = await createSourceExcerpt(
      harness.app,
      'A second source paragraph that will be edited to invalidate its hash.',
      { version: '1.0', page: '10' },
    );
    const source2Id = source2.body.id;

    const content = 'Hello world';
    const created = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId, source2Id],
      citations: [
        { sourceBlockId: sourceId, startOffset: 0, endOffset: 6 },
        { sourceBlockId: source2Id, startOffset: 4, endOffset: 11 },
      ],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.coveragePermille, 1000);

    // Edit source2 -> its content hash changes, invalidating citation #2.
    const patched = await patchSubmission(
      harness.app,
      source2Id,
      'A second source paragraph that has been edited, changing its content hash.',
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.revision, 2);

    // Live coverage now drops to the union of only the valid citation (#1),
    // which covers 5 non-ws chars -> 500.
    const fetched = await getSubmission(harness.app, created.body.id);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.coveragePermille, 500);
  });
});
