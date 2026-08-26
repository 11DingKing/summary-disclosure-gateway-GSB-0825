import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiSummary,
  createEditorSummary,
  createReaderNote,
  createSourceExcerpt,
  fullCoverageCitations,
  getPublication,
  getSubmission,
  listPublications,
  patchSubmission,
  publish,
  setupHarness,
} from './helpers.js';

test('Immutable publication snapshots', async (t) => {
  const harness = await setupHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const originalContent =
    'Original source content that was used when the AI summary was generated and published.';
  const source = await createSourceExcerpt(harness.app, originalContent, {
    version: '1.0',
    page: '12',
  });
  assert.equal(source.status, 201);
  const sourceId = source.body.id;
  const originalHash = source.body.contentHash;

  const aiContent =
    'AI summary whose every non-whitespace character is backed by a citation to the source block at publication time.';
  const ai = await createAiSummary(harness.app, {
    content: aiContent,
    sourceIds: [sourceId],
    citations: fullCoverageCitations(aiContent, sourceId),
  });
  assert.equal(ai.status, 201);
  const aiId = ai.body.id;

  const published = await publish(harness.app, aiId, { expectedRevision: 1 });
  assert.equal(published.status, 201);
  const publicationId = published.body.id;

  await t.test('snapshot freezes source content and hash at publish time', async () => {
    const res = await getPublication(harness.app, publicationId);
    assert.equal(res.status, 200);

    const snapshot = res.body.snapshot;
    assert.equal(snapshot.coveragePermille, 1000);
    assert.equal(snapshot.sourceHashesValid, true);
    assert.equal(snapshot.revision, 1);

    assert.equal(snapshot.submission.id, aiId);
    assert.equal(snapshot.submission.kind, 'AI_SUMMARY');
    assert.equal(snapshot.submission.content, aiContent);

    assert.equal(snapshot.citations.length, 1);
    const cited = snapshot.citations[0];
    assert.equal(cited.sourceBlockId, sourceId);
    assert.equal(cited.citedHash, originalHash);
    assert.equal(cited.sourceBlockHash, originalHash);
    assert.equal(cited.sourceBlockContent, originalContent);
    assert.equal(cited.sourceBlockVersion, '1.0');
    assert.equal(cited.sourceBlockPage, '12');
  });

  await t.test('editing the source does not mutate the published snapshot', async () => {
    const newContent =
      'This source block was edited after publication, changing its content hash and revision.';
    const patched = await patchSubmission(harness.app, sourceId, newContent);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.revision, 2);
    assert.notEqual(patched.body.contentHash, originalHash);

    // The live AI submission now has invalid citations and zero coverage...
    const live = await getSubmission(harness.app, aiId);
    assert.equal(live.status, 200);
    assert.equal(live.body.coveragePermille, 0);

    // ...but the published snapshot is frozen at 1000 with the original source.
    const res = await getPublication(harness.app, publicationId);
    assert.equal(res.status, 200);
    const snapshot = res.body.snapshot;
    assert.equal(snapshot.coveragePermille, 1000);
    assert.equal(snapshot.citations[0].sourceBlockContent, originalContent);
    assert.equal(snapshot.citations[0].sourceBlockHash, originalHash);
    assert.equal(snapshot.submission.revision, 1);
  });

  await t.test('non-AI submissions also produce immutable snapshots', async () => {
    const note = await createReaderNote(harness.app, 'A reader note to be published.');
    assert.equal(note.status, 201);
    const notePub = await publish(harness.app, note.body.id, { expectedRevision: 1 });
    assert.equal(notePub.status, 201);
    assert.equal(notePub.body.coveragePermille, 0);
    assert.equal(notePub.body.sourceHashesValid, true);
    assert.equal(notePub.body.snapshot.submission.kind, 'READER_NOTE');
  });

  await t.test('publications list returns the frozen snapshot and is cursor-paginated', async () => {
    // Add a couple more publications so there are multiple rows.
    const editor = await createEditorSummary(harness.app, 'An editor summary for the list.');
    await publish(harness.app, editor.body.id, { expectedRevision: 1 });
    const s2 = await createSourceExcerpt(
      harness.app,
      'Another source excerpt for a second AI summary publication.',
      { version: '1.0', page: '20' },
    );
    const ai2 = await createAiSummary(harness.app, {
      content: 'A second AI summary fully cited from the second source excerpt.',
      sourceIds: [s2.body.id],
      citations: fullCoverageCitations(
        'A second AI summary fully cited from the second source excerpt.',
        s2.body.id,
      ),
    });
    await publish(harness.app, ai2.body.id, { expectedRevision: 1 });

    const first = await listPublications(harness.app, '?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.nextCursor);

    const second = await listPublications(
      harness.app,
      `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    assert.equal(second.status, 200);
    assert.ok(second.body.items.length >= 1);

    // Stable ordering by (publishedAt, id) across pages.
    const all = [...first.body.items, ...second.body.items];
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1].publishedAt;
      const cur = all[i].publishedAt;
      assert.ok(
        cur > prev || (cur === prev && all[i].id > all[i - 1].id),
        'publications must be ordered by (publishedAt, id) asc',
      );
    }

    // Every list entry carries its frozen snapshot.
    const match = all.find((p: { id: string }) => p.id === publicationId);
    assert.ok(match);
    assert.equal(match.snapshot.citations[0].sourceBlockContent, originalContent);
  });
});
