import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTestContext } from './helpers.ts';

const ctx = await createTestContext();
after(async () => {
  await ctx.cleanup();
});

test('healthz reports ok', async () => {
  const res = await api(ctx.app, 'GET', '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('OpenAPI document is served and describes the gate', async () => {
  const res = await api(ctx.app, 'GET', '/v1/openapi.json');
  assert.equal(res.status, 200);
  assert.equal(res.body.openapi, '3.1.0');
  assert.ok(res.body.paths['/v1/submissions']);
  assert.ok(res.body.paths['/v1/publications']);
  assert.ok(res.body.paths['/v1/submissions/{id}']);
  assert.ok(res.body.paths['/v1/publications/{id}']);

  const kinds = res.body.components.schemas.SubmissionKind.enum;
  assert.deepEqual(kinds, [
    'SOURCE_EXCERPT',
    'READER_NOTE',
    'EDITOR_SUMMARY',
    'AI_SUMMARY',
  ]);

  const createSubmission = res.body.paths['/v1/submissions'].post;
  assert.ok(
    createSubmission.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key'),
  );
});
