import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createTestContext,
  inject,
  createSource,
  type TestContext,
} from "./helpers.js";
import type { FastifyInstance } from "fastify";

/**
 * Build an AI summary whose body is fully covered by a single citation into the
 * given source, i.e. coverage 1000 per mille. Returns the serialized summary.
 */
async function createFullyCoveredAiSummary(
  app: FastifyInstance,
  sourceId: string,
  body = "FullyCoveredSummaryText",
): Promise<any> {
  const res = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body,
      modelProvider: "acme",
      modelName: "summarizer-1",
      generatedAt: new Date().toISOString(),
      inputBlockIds: [sourceId],
      citations: [
        {
          sourceBlockId: sourceId,
          outputStart: 0,
          outputEnd: [...body].length,
        },
      ],
    },
  });
  if (res.status !== 201) {
    throw new Error(`ai summary create failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

let ctx: TestContext;
before(async () => {
  ctx = await createTestContext();
});
after(async () => {
  await ctx.close();
});

test("publish succeeds when policy v1 is satisfied and stores an immutable snapshot", async () => {
  const { app } = ctx;
  const source = await createSource(app, { docKey: "doc-1" });
  const ai = await createFullyCoveredAiSummary(app, source.id);

  const pub = await inject(app, "POST", "/v1/publications", {
    payload: {
      scope: "doc-1",
      policyVersion: "v1",
      expectedRevision: 0,
      submissionIds: [source.id, ai.id],
    },
  });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.revision, 1);
  assert.equal(pub.body.snapshot.schemaVersion, 1);
  assert.equal(pub.body.snapshot.policy.minCoveragePermille, 700);
  const snapshotAi = pub.body.snapshot.submissions.find(
    (s: any) => s.id === ai.id,
  );
  assert.equal(snapshotAi.coveragePermille, 1000);
});

test("policy v1 rejects AI summaries below 700 with machine-readable reasons", async () => {
  const { app } = ctx;
  const source = await createSource(app);
  // Body of 10 chars, only 2 cited => 200 per mille < 700.
  const ai = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "ABCDEFGHIJ",
      modelProvider: "acme",
      modelName: "m",
      generatedAt: new Date().toISOString(),
      inputBlockIds: [source.id],
      citations: [{ sourceBlockId: source.id, outputStart: 0, outputEnd: 2 }],
    },
  });
  const pub = await inject(app, "POST", "/v1/publications", {
    payload: {
      scope: "low-cov",
      policyVersion: "v1",
      expectedRevision: 0,
      submissionIds: [source.id, ai.body.id],
    },
  });
  assert.equal(pub.status, 422);
  assert.equal(pub.body.error.code, "POLICY_VIOLATION");
  assert.equal(pub.body.error.policyVersion, "v1");
  const reason = pub.body.error.reasons.find(
    (r: any) => r.code === "INSUFFICIENT_COVERAGE",
  );
  assert.ok(reason, "has an INSUFFICIENT_COVERAGE reason");
  assert.equal(reason.coveragePermille, 200);
  assert.equal(reason.requiredPermille, 700);
});

test("revising a source invalidates pinned citation hashes and blocks publish", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    const source = await createSource(app, { body: "SourceBodyText" });
    const ai = await createFullyCoveredAiSummary(app, source.id);

    // Before revision: fully covered.
    const before = await inject(app, "GET", `/v1/submissions/${ai.id}`);
    assert.equal(before.body.coveragePermille, 1000);

    // Revise the source: its contentHash changes, so the pinned citation hash
    // no longer matches and the cited span becomes invalid.
    const revised = await inject(app, "PATCH", `/v1/submissions/${source.id}`, {
      payload: { version: "v2" },
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.sourceRevision, 2);
    assert.notEqual(revised.body.contentHash, source.contentHash);

    // After revision: coverage collapses to 0 because the citation is stale.
    const after = await inject(app, "GET", `/v1/submissions/${ai.id}`);
    assert.equal(after.body.coveragePermille, 0);

    const pub = await inject(app, "POST", "/v1/publications", {
      payload: {
        scope: "hash-fail",
        policyVersion: "v1",
        expectedRevision: 0,
        submissionIds: [source.id, ai.id],
      },
    });
    assert.equal(pub.status, 422);
    const mismatch = pub.body.error.reasons.find(
      (r: any) => r.code === "SOURCE_HASH_MISMATCH",
    );
    assert.ok(mismatch, "reports a SOURCE_HASH_MISMATCH");
    assert.equal(mismatch.sourceBlockId, source.id);
  } finally {
    await localCtx.close();
  }
});

test("published snapshots are immutable: later source revisions do not rewrite history", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    const source = await createSource(app, { body: "HistoricalSourceText" });
    const ai = await createFullyCoveredAiSummary(app, source.id);

    const pub = await inject(app, "POST", "/v1/publications", {
      payload: {
        scope: "immutable",
        policyVersion: "v1",
        expectedRevision: 0,
        submissionIds: [source.id, ai.id],
      },
    });
    assert.equal(pub.status, 201);
    const publicationId = pub.body.id;
    const originalHash = pub.body.snapshot.submissions.find(
      (s: any) => s.id === source.id,
    ).contentHash;

    // Mutate the source after publication.
    await inject(app, "PATCH", `/v1/submissions/${source.id}`, {
      payload: { version: "v2", body: "CompletelyDifferentText" },
    });

    // Re-fetch the publication: snapshot still reflects the original source.
    const fetched = await inject(
      app,
      "GET",
      `/v1/publications/${publicationId}`,
    );
    const snapSource = fetched.body.snapshot.submissions.find(
      (s: any) => s.id === source.id,
    );
    assert.equal(snapSource.contentHash, originalHash);
    assert.equal(snapSource.body, "HistoricalSourceText");
    assert.equal(
      fetched.body.snapshot.submissions.find((s: any) => s.id === ai.id)
        .coveragePermille,
      1000,
      "snapshot preserves the coverage verdict at publish time",
    );
  } finally {
    await localCtx.close();
  }
});

test("expectedRevision mismatch returns REVISION_CONFLICT", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    const source = await createSource(app);
    const ai = await createFullyCoveredAiSummary(app, source.id);
    const payload = {
      scope: "conflict",
      policyVersion: "v1",
      expectedRevision: 0,
      submissionIds: [source.id, ai.id],
    };
    const first = await inject(app, "POST", "/v1/publications", { payload });
    assert.equal(first.status, 201);

    // Re-using expectedRevision 0 after revision 1 exists must conflict.
    const stale = await inject(app, "POST", "/v1/publications", { payload });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "REVISION_CONFLICT");
    assert.equal(stale.body.error.latestRevision, 1);
  } finally {
    await localCtx.close();
  }
});

test("concurrent publishes to the same scope: exactly one wins each revision", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    const source = await createSource(app);
    const ai = await createFullyCoveredAiSummary(app, source.id);
    const payload = {
      scope: "race",
      policyVersion: "v1",
      expectedRevision: 0,
      submissionIds: [source.id, ai.id],
    };

    // Fire several identical publishes (no idempotency key) at once. All race
    // for revision 1; the unique (scope, revision) constraint must let exactly
    // one through and reject the rest with REVISION_CONFLICT (or a conflict).
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        inject(app, "POST", "/v1/publications", { payload }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    assert.equal(created.length, 1, "exactly one publish succeeds");
    assert.equal(conflicts.length, 4, "the rest conflict");
    assert.equal(created[0]!.body.revision, 1);

    // Only one publication row exists in the scope.
    const list = await inject(app, "GET", "/v1/publications?scope=race");
    assert.equal(list.body.items.length, 1);
  } finally {
    await localCtx.close();
  }
});

test("concurrent publishes with the same idempotency key create exactly one row", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    const source = await createSource(app);
    const ai = await createFullyCoveredAiSummary(app, source.id);
    const headers = { "idempotency-key": "pub-key-1" };
    const payload = {
      scope: "idem-race",
      policyVersion: "v1",
      expectedRevision: 0,
      submissionIds: [source.id, ai.id],
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        inject(app, "POST", "/v1/publications", { payload, headers }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    assert.equal(ok.length, 5, "all return 201 (one real, rest replays)");
    const ids = new Set(ok.map((r) => r.body.id));
    assert.equal(ids.size, 1, "all replays share one publication id");

    const list = await inject(app, "GET", "/v1/publications?scope=idem-race");
    assert.equal(list.body.items.length, 1);
  } finally {
    await localCtx.close();
  }
});

test("unsupported policy version is rejected", async () => {
  const { app } = ctx;
  const source = await createSource(app);
  const res = await inject(app, "POST", "/v1/publications", {
    payload: {
      scope: "x",
      policyVersion: "v2",
      expectedRevision: 0,
      submissionIds: [source.id],
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "UNSUPPORTED_POLICY_VERSION");
});
