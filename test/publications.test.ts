import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  cpLen,
  createTestContext,
  sourcePayload,
  SOURCE_BODY,
  aiPayload,
  publishPayload,
} from './helpers.ts';

const ctx = await createTestContext();
after(async () => {
  await ctx.cleanup();
});

async function createSource(docKey: string, overrides: Record<string, unknown> = {}) {
  const res = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ docKey, ...overrides }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function createFullyCitedAi(source: { id: string; body: string }, docKey: string) {
  const body = source.body;
  const res = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(source.id, body, [{ outputStart: 0, outputEnd: cpLen(body) }], { docKey }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('publishing a fully cited AI summary creates an immutable snapshot', async () => {
  const source = await createSource('doc-happy');
  const ai = await createFullyCitedAi(source, 'doc-happy');

  const res = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.id], 0, { scope: 'scope-happy' }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.revision, 1);
  assert.equal(res.body.policyVersion, 'v1');
  assert.equal(res.body.scope, 'scope-happy');
  assert.ok(res.body.snapshot);
  assert.equal(res.body.snapshot.policy.minCoveragePermille, 700);

  const snapshotSource = res.body.snapshot.submissions.find((s: { id: string }) => s.id === source.id);
  const snapshotAi = res.body.snapshot.submissions.find((s: { id: string }) => s.id === ai.id);
  assert.ok(snapshotSource);
  assert.ok(snapshotAi);
  assert.equal(snapshotSource.version, 'v1');
  assert.equal(snapshotSource.contentHash, source.contentHash);
  assert.equal(snapshotAi.coveragePermille, 1000);
  assert.equal(res.body.snapshot.policy.aiResults[0].submissionId, ai.id);
  assert.equal(res.body.snapshot.policy.aiResults[0].validCitationCount, 1);
  assert.equal(res.body.snapshot.policy.aiResults[0].invalidCitationCount, 0);
});

test('unsupported policyVersion is rejected with a machine-readable error', async () => {
  const source = await createSource('doc-policy');
  const res = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([source.id], 0, { scope: 'scope-policy', policyVersion: 'v9' }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'UNSUPPORTED_POLICY_VERSION');
  assert.deepEqual(res.body.error.supportedPolicyVersions, ['v1']);
});

test('expectedRevision mismatch yields REVISION_CONFLICT (409)', async () => {
  const source = await createSource('doc-rev');
  const ai = await createFullyCitedAi(source, 'doc-rev');

  const first = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.id], 0, { scope: 'scope-rev' }),
  );
  assert.equal(first.status, 201);
  assert.equal(first.body.revision, 1);

  const stale = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.id], 0, { scope: 'scope-rev' }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  assert.equal(stale.body.error.expectedRevision, 0);
  assert.equal(stale.body.error.latestRevision, 1);
});

test('publishing supports idempotency keys', async () => {
  const source = await createSource('doc-idem-pub');
  const ai = await createFullyCitedAi(source, 'doc-idem-pub');
  const payload = publishPayload([ai.id], 0, { scope: 'scope-idem-pub' });

  const first = await api(ctx.app, 'POST', '/v1/publications', payload, {
    'Idempotency-Key': 'pub-key-1',
  });
  assert.equal(first.status, 201);
  assert.equal(first.headers['idempotency-replayed'], 'false');

  const replay = await api(ctx.app, 'POST', '/v1/publications', payload, {
    'Idempotency-Key': 'pub-key-1',
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotency-replayed'], 'true');
  assert.equal(replay.body.id, first.body.id);

  const reuse = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.id], 99, { scope: 'scope-idem-pub' }),
    { 'Idempotency-Key': 'pub-key-1' },
  );
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'IDEMPOTENCY_KEY_REUSE');
});

test('AI summary below 700 coverage is rejected with INSUFFICIENT_COVERAGE reasons', async () => {
  const source = await createSource('doc-lowcov');
  const body = 'one two three four five six seven eight nine ten';
  const partialEnd = cpLen('one two three');
  const ai = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(source.id, body, [{ outputStart: 0, outputEnd: partialEnd }], { docKey: 'doc-lowcov' }),
  );
  assert.equal(ai.status, 201);
  const expectedPermille = Math.floor(('onetwothree'.length * 1000) / body.replace(/\s/gu, '').length);
  assert.ok(expectedPermille < 700);

  const res = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.body.id], 0, { scope: 'scope-lowcov' }),
  );
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'POLICY_VIOLATION');
  assert.equal(res.body.error.policyVersion, 'v1');

  const reasons = res.body.error.reasons as Array<{ code: string; coveragePermille?: number; requiredPermille?: number }>;
  const coverageReason = reasons.find((r) => r.code === 'INSUFFICIENT_COVERAGE');
  assert.ok(coverageReason, 'expected an INSUFFICIENT_COVERAGE reason');
  assert.equal(coverageReason.coveragePermille, expectedPermille);
  assert.equal(coverageReason.requiredPermille, 700);
});

test('unknown submission ids are rejected (404)', async () => {
  const res = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload(['cuid-does-not-exist'], 0, { scope: 'scope-404' }),
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'SUBMISSION_NOT_FOUND');
  assert.deepEqual(res.body.error.missingSubmissionIds, ['cuid-does-not-exist']);
});

test('publications without AI summaries pass policy v1', async () => {
  const source = await createSource('doc-source-only');
  const note = await api(ctx.app, 'POST', '/v1/submissions', {
    kind: 'READER_NOTE',
    docKey: 'doc-source-only',
    body: 'a reader note published alongside the excerpt',
  });
  assert.equal(note.status, 201);

  const res = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([source.id, note.body.id], 0, { scope: 'scope-source-only' }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.snapshot.policy.aiResults.length, 0);
});

test('source revision invalidates citation hashes but never rewrites historical snapshots', async () => {
  const source = await createSource('doc-gate');
  const ai = await createFullyCitedAi(source, 'doc-gate');
  const originalHash = source.contentHash;

  const first = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.id], 0, { scope: 'scope-gate' }),
  );
  assert.equal(first.status, 201);
  const firstPublicationId = first.body.id;

  const revisedBody = `${SOURCE_BODY} Revised second edition with corrected wording.`;
  const revised = await api(ctx.app, 'PATCH', `/v1/submissions/${source.id}`, {
    version: 'v2',
    body: revisedBody,
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.sourceRevision, 2);
  const revisedHash = revised.body.contentHash;
  assert.notEqual(revisedHash, originalHash);

  const liveAi = await api(ctx.app, 'GET', `/v1/submissions/${ai.id}`);
  assert.equal(liveAi.status, 200);
  assert.equal(liveAi.body.coveragePermille, 0);
  assert.equal(liveAi.body.citations[0].sourceContentHash, originalHash);

  const stalePublish = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai.id], 1, { scope: 'scope-gate' }),
  );
  assert.equal(stalePublish.status, 422, JSON.stringify(stalePublish.body));
  assert.equal(stalePublish.body.error.code, 'POLICY_VIOLATION');
  const reasons = stalePublish.body.error.reasons as Array<Record<string, unknown>>;

  const hashReason = reasons.find((r) => r.code === 'SOURCE_HASH_MISMATCH');
  assert.ok(hashReason, 'expected a SOURCE_HASH_MISMATCH reason');
  assert.equal(hashReason.citedHash, originalHash);
  assert.equal(hashReason.currentHash, revisedHash);
  assert.equal(hashReason.sourceBlockId, source.id);

  const coverageReason = reasons.find((r) => r.code === 'INSUFFICIENT_COVERAGE');
  assert.ok(coverageReason, 'expected an INSUFFICIENT_COVERAGE reason');
  assert.equal(coverageReason.coveragePermille, 0);

  const historical = await api(ctx.app, 'GET', `/v1/publications/${firstPublicationId}`);
  assert.equal(historical.status, 200);
  const snapshotSource = historical.body.snapshot.submissions.find(
    (s: { id: string }) => s.id === source.id,
  );
  const snapshotAi = historical.body.snapshot.submissions.find(
    (s: { id: string }) => s.id === ai.id,
  );
  assert.equal(snapshotSource.version, 'v1');
  assert.equal(snapshotSource.sourceRevision, 1);
  assert.equal(snapshotSource.body, SOURCE_BODY);
  assert.equal(snapshotSource.contentHash, originalHash);
  assert.equal(snapshotAi.coveragePermille, 1000);
  assert.equal(snapshotAi.citations[0].sourceContentHash, originalHash);

  const liveSource = await api(ctx.app, 'GET', `/v1/submissions/${source.id}`);
  assert.equal(liveSource.body.version, 'v2');
  assert.equal(liveSource.body.body, revisedBody);
  assert.equal(liveSource.body.contentHash, revisedHash);

  const ai2Body = revisedBody;
  const ai2 = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(
      source.id,
      ai2Body,
      [{ outputStart: 0, outputEnd: cpLen(ai2Body) }],
      { docKey: 'doc-gate' },
    ),
  );
  assert.equal(ai2.status, 201);
  assert.equal(ai2.body.coveragePermille, 1000);

  const second = await api(
    ctx.app,
    'POST',
    '/v1/publications',
    publishPayload([ai2.body.id], 1, { scope: 'scope-gate' }),
  );
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.revision, 2);

  const historicalAgain = await api(ctx.app, 'GET', `/v1/publications/${firstPublicationId}`);
  assert.equal(historicalAgain.body.snapshot.submissions.length, 2);
  assert.equal(
    historicalAgain.body.snapshot.submissions.find((s: { id: string }) => s.id === source.id).version,
    'v1',
  );
});

test('concurrent publishes: exactly one wins, losers get REVISION_CONFLICT', async () => {
  const source = await createSource('doc-concurrent');
  const ai = await createFullyCitedAi(source, 'doc-concurrent');

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      api(
        ctx.app,
        'POST',
        '/v1/publications',
        publishPayload([ai.id], 0, { scope: 'scope-concurrent' }),
      ),
    ),
  );

  const statuses = attempts.map((a) => a.status).sort();
  const winners = attempts.filter((a) => a.status === 201);
  const losers = attempts.filter((a) => a.status === 409);

  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(statuses)}`);
  assert.equal(losers.length, 4, `expected four conflicts, got ${JSON.stringify(statuses)}`);
  for (const loser of losers) {
    assert.equal(loser.body.error.code, 'REVISION_CONFLICT');
  }
  for (const attempt of attempts) {
    assert.ok(attempt.status === 201 || attempt.status === 409, `unexpected status ${attempt.status}`);
  }
  assert.equal(winners[0].body.revision, 1);

  const stored = await ctx.db.publication.findMany({ where: { scope: 'scope-concurrent' } });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].revision, 1);
});

test('publications list uses cursor pagination and unknown ids 404', async () => {
  const page1 = await api(ctx.app, 'GET', '/v1/publications?scope=scope-gate&limit=1');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 1);
  assert.equal(page1.body.hasMore, true);

  const page2 = await api(
    ctx.app,
    'GET',
    `/v1/publications?scope=scope-gate&limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
  );
  assert.equal(page2.status, 200);
  assert.equal(page2.body.hasMore, false);
  const revisions = [page1.body.items[0].revision, page2.body.items[0].revision].sort();
  assert.deepEqual(revisions, [1, 2]);

  const missing = await api(ctx.app, 'GET', '/v1/publications/cuid-nope');
  assert.equal(missing.status, 404);
});
