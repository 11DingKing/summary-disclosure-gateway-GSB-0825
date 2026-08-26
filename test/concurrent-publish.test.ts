import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAiSummary,
  createSourceExcerpt,
  fullCoverageCitations,
  publish,
  setupHarness,
} from './helpers.js';

async function makePublishableAiSummary(app: Awaited<ReturnType<typeof setupHarness>>['app']) {
  const source = await createSourceExcerpt(
    app,
    'Source material that fully supports the AI-generated output for concurrency tests.',
    { version: '1.0', page: '1' },
  );
  assert.equal(source.status, 201);
  const sourceId = source.body.id;

  const content =
    'AI summary output that is fully backed by the cited source so policy v1 accepts it.';
  const ai = await createAiSummary(app, {
    content,
    sourceIds: [sourceId],
    citations: fullCoverageCitations(content, sourceId),
  });
  assert.equal(ai.status, 201);
  return { sourceId, submissionId: ai.body.id };
}

test('Concurrent publishing', async (t) => {
  const harness = await setupHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  await t.test('only one of two concurrent publishes wins (different keys)', async () => {
    const { submissionId } = await makePublishableAiSummary(harness.app);

    const [a, b] = await Promise.all([
      publish(harness.app, submissionId, {
        expectedRevision: 1,
        idempotencyKey: 'key-a',
      }),
      publish(harness.app, submissionId, {
        expectedRevision: 1,
        idempotencyKey: 'key-b',
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected 201+409, got ${statuses.join(',')}`);

    const winner = a.status === 201 ? a : b;
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.error.code, 'ALREADY_PUBLISHED');
    assert.equal(winner.body.submissionId, submissionId);

    // A subsequent publish is also rejected.
    const again = await publish(harness.app, submissionId, { expectedRevision: 1 });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_PUBLISHED');
  });

  await t.test('publishing with the same idempotency key replays the winner', async () => {
    const { submissionId } = await makePublishableAiSummary(harness.app);

    const first = await publish(harness.app, submissionId, {
      expectedRevision: 1,
      idempotencyKey: 'retry-key',
    });
    assert.equal(first.status, 201);

    // A sequential retry with the same key replays the stored response.
    const second = await publish(harness.app, submissionId, {
      expectedRevision: 1,
      idempotencyKey: 'retry-key',
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);

    // A concurrent retry with the same key also converges on the same
    // publication rather than creating a duplicate.
    const [a, b] = await Promise.all([
      publish(harness.app, submissionId, {
        expectedRevision: 1,
        idempotencyKey: 'retry-key',
      }),
      publish(harness.app, submissionId, {
        expectedRevision: 1,
        idempotencyKey: 'retry-key',
      }),
    ]);
    for (const res of [a, b]) {
      assert.ok(
        res.status === 200 || res.status === 409,
        `expected 200 or 409, got ${res.status}`,
      );
      if (res.status === 200) {
        assert.equal(res.body.id, first.body.id);
      } else {
        assert.equal(res.body.error.code, 'ALREADY_PUBLISHED');
      }
    }
  });

  await t.test('rejects when expectedRevision does not match', async () => {
    const { submissionId } = await makePublishableAiSummary(harness.app);
    const res = await publish(harness.app, submissionId, {
      expectedRevision: 99,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'REVISION_MISMATCH');
    assert.equal(res.body.error.details.currentRevision, 1);
  });

  await t.test('idempotent submission creation returns the same resource', async () => {
    const [a, b] = await Promise.all([
      createSourceExcerpt(
        harness.app,
        'A source excerpt created with an idempotency key.',
        { version: '1.0', page: '7', idempotencyKey: 'source-key-1' },
      ),
      createSourceExcerpt(
        harness.app,
        'A source excerpt created with an idempotency key.',
        { version: '1.0', page: '7', idempotencyKey: 'source-key-1' },
      ),
    ]);
    assert.equal(a.body.id, b.body.id);
  });
});
