import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  cpLen,
  createTestContext,
  sourcePayload,
  SOURCE_BODY,
  aiPayload,
} from './helpers.ts';

const ctx = await createTestContext();
after(async () => {
  await ctx.cleanup();
});

test('SOURCE_EXCERPT requires version and page numbers', async () => {
  const missingVersion = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ version: undefined }));
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.body.error.code, 'VALIDATION_ERROR');

  const missingPages = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ pageEnd: undefined }));
  assert.equal(missingPages.status, 400);

  const badRange = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ pageStart: 20, pageEnd: 5 }));
  assert.equal(badRange.status, 400);
});

test('SOURCE_EXCERPT gets a server-computed content hash and no AI fields', async () => {
  const res = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload());
  assert.equal(res.status, 201);
  assert.match(res.body.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(res.body.kind, 'SOURCE_EXCERPT');
  assert.equal(res.body.version, 'v1');
  assert.equal(res.body.pageStart, 12);
  assert.equal(res.body.pageEnd, 13);
  assert.equal(res.body.sourceRevision, 1);
  assert.equal(res.body.coveragePermille, null);
  assert.equal(res.body.modelProvider, null);
  assert.equal(res.body.modelName, null);
  assert.equal(res.body.generatedAt, null);
  assert.deepEqual(res.body.citations, []);
  assert.deepEqual(res.body.inputBlockIds, []);
});

test('unknown kind is rejected', async () => {
  const res = await api(ctx.app, 'POST', '/v1/submissions', { kind: 'POEM', body: 'x' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /kind/);
});

test('READER_NOTE and EDITOR_SUMMARY carry neither source nor AI fields', async () => {
  const note = await api(ctx.app, 'POST', '/v1/submissions', {
    kind: 'READER_NOTE',
    body: 'my personal thought',
  });
  assert.equal(note.status, 201);
  assert.equal(note.body.contentHash, null);
  assert.equal(note.body.version, null);
  assert.equal(note.body.coveragePermille, null);
  assert.equal(note.body.modelProvider, null);
  assert.deepEqual(note.body.citations, []);

  const editorial = await api(ctx.app, 'POST', '/v1/submissions', {
    kind: 'EDITOR_SUMMARY',
    body: 'editor summary text',
  });
  assert.equal(editorial.status, 201);
  assert.equal(editorial.body.contentHash, null);
  assert.equal(editorial.body.modelProvider, null);
});

test('AI_SUMMARY requires model metadata, input blocks and citation spans', async () => {
  const source = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ docKey: 'doc-ai' }));
  const sourceId = source.body.id;
  const body = SOURCE_BODY;

  const noProvider = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(sourceId, body, [{ outputStart: 0, outputEnd: 10 }], { modelProvider: undefined }),
  );
  assert.equal(noProvider.status, 400);

  const noGeneratedAt = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(sourceId, body, [{ outputStart: 0, outputEnd: 10 }], { generatedAt: undefined }),
  );
  assert.equal(noGeneratedAt.status, 400);

  const noCitations = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(sourceId, body, []),
  );
  assert.equal(noCitations.status, 400);

  const spanBeyondBody = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(sourceId, body, [{ outputStart: 0, outputEnd: cpLen(body) + 50 }]),
  );
  assert.equal(spanBeyondBody.status, 400);

  const missingSource = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload('cuid-does-not-exist', body, [{ outputStart: 0, outputEnd: 10 }]),
  );
  assert.equal(missingSource.status, 404);
  assert.equal(missingSource.body.error.code, 'SOURCE_BLOCK_NOT_FOUND');

  const note = await api(ctx.app, 'POST', '/v1/submissions', {
    kind: 'READER_NOTE',
    body: 'not a source',
  });
  const nonSourceInput = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(note.body.id, body, [{ outputStart: 0, outputEnd: 10 }]),
  );
  assert.equal(nonSourceInput.status, 400);
});

test('server ignores client-supplied coverage and hashes, computes its own', async () => {
  const source = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ docKey: 'doc-trust' }));
  const body = SOURCE_BODY;

  const res = await api(ctx.app, 'POST', '/v1/submissions', {
    ...aiPayload(source.body.id, body, [
      { outputStart: 0, outputEnd: cpLen(body) },
    ]),
    coveragePermille: 1,
    contentHash: 'client-forged-hash',
    citations: [
      {
        sourceBlockId: source.body.id,
        outputStart: 0,
        outputEnd: cpLen(body),
        sourceContentHash: 'deadbeefdeadbeef',
      },
    ],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.coveragePermille, 1000);
  assert.equal(res.body.citations[0].sourceContentHash, source.body.contentHash);
  assert.notEqual(res.body.citations[0].sourceContentHash, 'deadbeefdeadbeef');
  assert.equal(res.body.contentHash, null);
});

test('coveragePermille reflects partially cited output (Unicode aware)', async () => {
  const source = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ docKey: 'doc-cov' }));
  const body = 'one two three four five six seven eight nine ten';
  const end = cpLen('one two three');
  const res = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    aiPayload(source.body.id, body, [{ outputStart: 0, outputEnd: end }]),
  );
  assert.equal(res.status, 201);
  const letters = body.replace(/\s/gu, '').length;
  const coveredLetters = 'onetwothree'.length;
  assert.equal(res.body.coveragePermille, Math.floor((coveredLetters * 1000) / letters));
  assert.ok(res.body.coveragePermille < 700);
});

test('PATCH revises SOURCE_EXCERPT with new version and recomputed hash; other kinds are immutable', async () => {
  const source = await api(ctx.app, 'POST', '/v1/submissions', sourcePayload({ docKey: 'doc-patch' }));
  const originalHash = source.body.contentHash;

  const sameVersion = await api(ctx.app, 'PATCH', `/v1/submissions/${source.body.id}`, {
    version: 'v1',
  });
  assert.equal(sameVersion.status, 409);
  assert.equal(sameVersion.body.error.code, 'VERSION_MUST_ADVANCE');

  const revised = await api(ctx.app, 'PATCH', `/v1/submissions/${source.body.id}`, {
    version: 'v2',
    body: `${SOURCE_BODY} Updated second edition text.`,
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.sourceRevision, 2);
  assert.equal(revised.body.version, 'v2');
  assert.notEqual(revised.body.contentHash, originalHash);
  assert.match(revised.body.contentHash, /^[0-9a-f]{64}$/);

  const note = await api(ctx.app, 'POST', '/v1/submissions', {
    kind: 'READER_NOTE',
    body: 'immutable note',
  });
  const patchNote = await api(ctx.app, 'PATCH', `/v1/submissions/${note.body.id}`, {
    version: 'v2',
  });
  assert.equal(patchNote.status, 409);
  assert.equal(patchNote.body.error.code, 'IMMUTABLE_SUBMISSION');

  const patchMissing = await api(ctx.app, 'PATCH', '/v1/submissions/cuid-nope', {
    version: 'v2',
  });
  assert.equal(patchMissing.status, 404);
});

test('creation endpoints support idempotency keys and detect key reuse', async () => {
  const payload = sourcePayload({ docKey: 'doc-idem' });
  const first = await api(ctx.app, 'POST', '/v1/submissions', payload, {
    'Idempotency-Key': 'seed-key-001',
  });
  assert.equal(first.status, 201);
  assert.equal(first.headers['idempotency-replayed'], 'false');

  const replay = await api(ctx.app, 'POST', '/v1/submissions', payload, {
    'Idempotency-Key': 'seed-key-001',
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotency-replayed'], 'true');
  assert.equal(replay.body.id, first.body.id);

  const reuse = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    sourcePayload({ docKey: 'doc-idem', body: 'different body content entirely' }),
    { 'Idempotency-Key': 'seed-key-001' },
  );
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'IDEMPOTENCY_KEY_REUSE');

  const list = await api(ctx.app, 'GET', '/v1/submissions?docKey=doc-idem');
  assert.equal(list.body.items.length, 1);
});

test('concurrent identical requests with one Idempotency-Key create at most one submission', async () => {
  const payload = {
    kind: 'READER_NOTE',
    docKey: 'doc-race-same',
    body: 'concurrent identical idempotent note',
  };
  const key = 'race-key-same';

  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      api(ctx.app, 'POST', '/v1/submissions', payload, { 'Idempotency-Key': key }),
    ),
  );

  for (const res of responses) {
    assert.equal(res.status, 201);
  }
  const createdIds = new Set(responses.map((res) => res.body.id));
  assert.equal(createdIds.size, 1, 'all concurrent callers must observe the same submission id');
  assert.equal(
    responses.filter((res) => res.headers['idempotency-replayed'] === 'false').length,
    1,
    'exactly one request executes the creation',
  );
  assert.equal(
    responses.filter((res) => res.headers['idempotency-replayed'] === 'true').length,
    11,
  );

  const rows = await ctx.db.submission.findMany({ where: { docKey: 'doc-race-same' } });
  assert.equal(rows.length, 1, 'the race must not leave duplicate submissions behind');
  assert.equal(rows[0].id, [...createdIds][0]);

  const record = await ctx.db.idempotencyRecord.findUnique({
    where: { key: `POST /v1/submissions:${key}` },
  });
  assert.ok(record);
  assert.equal(record.status, 'COMPLETED');
  assert.equal(record.statusCode, 201);
});

test('concurrent conflicting requests with one Idempotency-Key yield one creation and 409 reuses', async () => {
  const key = 'race-key-reuse';
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      api(
        ctx.app,
        'POST',
        '/v1/submissions',
        {
          kind: 'READER_NOTE',
          docKey: 'doc-race-reuse',
          body: `concurrent conflicting note number ${i}`,
        },
        { 'Idempotency-Key': key },
      ),
    ),
  );

  const created = responses.filter((res) => res.status === 201);
  const rejected = responses.filter((res) => res.status === 409);
  assert.equal(created.length, 1, 'exactly one payload may win the key');
  assert.equal(rejected.length, 5);
  for (const res of rejected) {
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REUSE');
  }

  const rows = await ctx.db.submission.findMany({ where: { docKey: 'doc-race-reuse' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created[0].body.id);
});

test('a failed reserved request releases the key for a later retry', async () => {
  const key = 'race-key-failed';
  const invalid = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    { kind: 'READER_NOTE', docKey: 'doc-race-fail', body: '' },
    { 'Idempotency-Key': key },
  );
  assert.equal(invalid.status, 400);

  const retry = await api(
    ctx.app,
    'POST',
    '/v1/submissions',
    { kind: 'READER_NOTE', docKey: 'doc-race-fail', body: 'retried after validation failure' },
    { 'Idempotency-Key': key },
  );
  assert.equal(retry.status, 201);
  assert.equal(retry.headers['idempotency-replayed'], 'false');

  const rows = await ctx.db.submission.findMany({ where: { docKey: 'doc-race-fail' } });
  assert.equal(rows.length, 1);
});

test('list endpoints use stable cursor pagination over (createdAt,id)', async () => {
  for (let i = 0; i < 5; i += 1) {
    const res = await api(ctx.app, 'POST', '/v1/submissions', {
      kind: 'READER_NOTE',
      docKey: 'doc-page',
      body: `note number ${i} for pagination`,
    });
    assert.equal(res.status, 201);
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const url = `/v1/submissions?docKey=doc-page&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await api(ctx.app, 'GET', url);
    assert.equal(page.status, 200);
    assert.equal(page.body.limit, 2);
    pages += 1;
    for (const item of page.body.items) {
      seen.push(item.id);
    }
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null);
      break;
    }
    assert.ok(page.body.nextCursor);
    cursor = page.body.nextCursor;
    if (pages > 10) {
      assert.fail('pagination did not terminate');
    }
  }

  assert.equal(new Set(seen).size, 5);
  assert.equal(seen.length, 5);
  assert.ok(pages >= 3);

  const ordered = await api(ctx.app, 'GET', '/v1/submissions?docKey=doc-page&limit=100');
  const orderedIds = ordered.body.items.map((s: { id: string }) => s.id);
  assert.deepEqual(seen, orderedIds);
});

test('list filters by kind and rejects bad cursors/limits', async () => {
  const filtered = await api(ctx.app, 'GET', '/v1/submissions?kind=AI_SUMMARY&limit=100');
  assert.equal(filtered.status, 200);
  for (const item of filtered.body.items) {
    assert.equal(item.kind, 'AI_SUMMARY');
  }

  const badKind = await api(ctx.app, 'GET', '/v1/submissions?kind=NOPE');
  assert.equal(badKind.status, 400);

  const badLimit = await api(ctx.app, 'GET', '/v1/submissions?limit=9999');
  assert.equal(badLimit.status, 400);

  const badCursor = await api(ctx.app, 'GET', '/v1/submissions?cursor=%%%not-valid');
  assert.equal(badCursor.status, 400);
});

test('fetching a missing submission returns 404', async () => {
  const res = await api(ctx.app, 'GET', '/v1/submissions/cuid-missing');
  assert.equal(res.status, 404);
});
