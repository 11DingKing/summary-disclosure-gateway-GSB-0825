import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiSummary,
  createSourceExcerpt,
  fullCoverageCitations,
  getPublication,
  getSubmission,
  patchSubmission,
  publish,
  setupHarness,
} from './helpers.js';

test('Source hash invalidation', async (t) => {
  const harness = await setupHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const source = await createSourceExcerpt(
    harness.app,
    'Original source text that will be cited before it is edited.',
    { version: '1.0', page: '3' },
  );
  assert.equal(source.status, 201);
  const sourceId = source.body.id;

  const content =
    'AI summary that faithfully cites the source across nearly all of its non-whitespace output.';
  const citations = fullCoverageCitations(content, sourceId);

  const first = await createAiSummary(harness.app, {
    content,
    sourceIds: [sourceId],
    citations,
  });
  assert.equal(first.status, 201);
  const firstId = first.body.id;
  let firstPublicationId = '';

  await t.test('publishes while all source hashes are valid', async () => {
    const res = await publish(harness.app, firstId, { expectedRevision: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.coveragePermille, 1000);
    assert.equal(res.body.sourceHashesValid, true);
    assert.equal(res.body.policyVersion, 1);
    firstPublicationId = res.body.id;
  });

  await t.test('rejects publication after the source hash changes', async () => {
    // A second AI summary created before the edit, citing the original hash.
    const second = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations,
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.coveragePermille, 1000);

    // Edit the source excerpt: content hash changes, revision bumps.
    const patched = await patchSubmission(
      harness.app,
      sourceId,
      'Edited source text that changes the content hash and invalidates prior citations.',
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.revision, 2);
    assert.notEqual(patched.body.contentHash, source.body.contentHash);

    // The second summary's live coverage collapses because its citedHash no
    // longer matches the source's current hash.
    const fetched = await getSubmission(harness.app, second.body.id);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.coveragePermille, 0);

    // Publishing is rejected with a machine-readable policy violation.
    const rejected = await publish(harness.app, second.body.id, {
      expectedRevision: 1,
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, 'POLICY_VIOLATION');
    const codes = rejected.body.error.details.rejections.map(
      (r: { code: string }) => r.code,
    );
    assert.ok(codes.includes('SOURCE_HASH_INVALID'));
    assert.ok(codes.includes('COVERAGE_TOO_LOW'));

    const hashRejection = rejected.body.error.details.rejections.find(
      (r: { code: string }) => r.code === 'SOURCE_HASH_INVALID',
    );
    assert.equal(hashRejection.details.invalidCitations.length, 1);
    assert.equal(
      hashRejection.details.invalidCitations[0].reason,
      'SOURCE_HASH_MISMATCH',
    );
  });

  await t.test('a summary citing the new hash publishes successfully', async () => {
    const fresh = await createAiSummary(harness.app, {
      content,
      sourceIds: [sourceId],
      citations: fullCoverageCitations(content, sourceId),
    });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.coveragePermille, 1000);

    const res = await publish(harness.app, fresh.body.id, {
      expectedRevision: 1,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.sourceHashesValid, true);
  });

  await t.test('the earlier published snapshot is unaffected by the edit', async () => {
    const list = await getPublication(harness.app, firstPublicationId);
    assert.equal(list.status, 200);
    const citedSource = list.body.snapshot.citations[0];
    assert.equal(citedSource.sourceBlockHash, source.body.contentHash);
    assert.equal(citedSource.sourceBlockContent, source.body.content);
  });
});
