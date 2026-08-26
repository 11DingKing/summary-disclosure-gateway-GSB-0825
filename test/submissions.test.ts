import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createTestContext,
  inject,
  createSource,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

test("the four kinds are stored distinctly and never disguised", async () => {
  const { app } = ctx;
  const source = await createSource(app, {
    body: "Original source text here.",
  });
  assert.equal(source.kind, "SOURCE_EXCERPT");
  assert.ok(source.contentHash, "source excerpt has a server-computed hash");
  assert.equal(source.coveragePermille, null);

  const note = await inject(app, "POST", "/v1/submissions", {
    payload: { kind: "READER_NOTE", body: "A reader note." },
  });
  assert.equal(note.status, 201);
  assert.equal(note.body.kind, "READER_NOTE");
  assert.equal(note.body.contentHash, null);
  assert.equal(note.body.version, null);

  const editor = await inject(app, "POST", "/v1/submissions", {
    payload: { kind: "EDITOR_SUMMARY", body: "An editor summary." },
  });
  assert.equal(editor.body.kind, "EDITOR_SUMMARY");
  assert.equal(editor.body.modelProvider, null);
});

test("SOURCE_EXCERPT requires version and page numbers", async () => {
  const { app } = ctx;
  const noVersion = await inject(app, "POST", "/v1/submissions", {
    payload: { kind: "SOURCE_EXCERPT", body: "x", pageStart: 1, pageEnd: 2 },
  });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.body.error.code, "VALIDATION_ERROR");

  const noPages = await inject(app, "POST", "/v1/submissions", {
    payload: { kind: "SOURCE_EXCERPT", body: "x", version: "v1" },
  });
  assert.equal(noPages.status, 400);
});

test("AI_SUMMARY requires model metadata, inputs and citations", async () => {
  const { app } = ctx;
  const source = await createSource(app);

  const missingModel = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "Summary text.",
      inputBlockIds: [source.id],
      generatedAt: new Date().toISOString(),
      citations: [{ sourceBlockId: source.id, outputStart: 0, outputEnd: 5 }],
    },
  });
  assert.equal(missingModel.status, 400);
  assert.equal(missingModel.body.error.field, "modelProvider");

  const ok = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "Summary text.",
      modelProvider: "acme",
      modelName: "summarizer-1",
      generatedAt: new Date().toISOString(),
      inputBlockIds: [source.id],
      citations: [{ sourceBlockId: source.id, outputStart: 0, outputEnd: 13 }],
    },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.kind, "AI_SUMMARY");
  assert.equal(ok.body.modelProvider, "acme");
  // Coverage is computed by the server (full body cited => 1000).
  assert.equal(ok.body.coveragePermille, 1000);
  assert.equal(ok.body.citations.length, 1);
  assert.ok(
    ok.body.citations[0].sourceContentHash,
    "citation pins source hash",
  );
});

test("AI_SUMMARY may only cite existing SOURCE_EXCERPT blocks", async () => {
  const { app } = ctx;
  const note = await inject(app, "POST", "/v1/submissions", {
    payload: { kind: "READER_NOTE", body: "note body" },
  });

  const citesNote = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "Summary",
      modelProvider: "acme",
      modelName: "m",
      generatedAt: new Date().toISOString(),
      inputBlockIds: [note.body.id],
      citations: [
        { sourceBlockId: note.body.id, outputStart: 0, outputEnd: 7 },
      ],
    },
  });
  assert.equal(citesNote.status, 400);
  assert.deepEqual(citesNote.body.error.nonSourceBlockIds, [note.body.id]);

  const missingSource = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "Summary",
      modelProvider: "acme",
      modelName: "m",
      generatedAt: new Date().toISOString(),
      inputBlockIds: ["nonexistent"],
      citations: [
        { sourceBlockId: "nonexistent", outputStart: 0, outputEnd: 7 },
      ],
    },
  });
  assert.equal(missingSource.status, 404);
  assert.equal(missingSource.body.error.code, "SOURCE_BLOCK_NOT_FOUND");
});

test("client-supplied coveragePermille and contentHash are ignored", async () => {
  const { app } = ctx;
  const source = await createSource(app);
  const res = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "ABCDEFGHIJ", // 10 chars, cite only 2 => 200 per mille
      modelProvider: "acme",
      modelName: "m",
      generatedAt: new Date().toISOString(),
      inputBlockIds: [source.id],
      citations: [{ sourceBlockId: source.id, outputStart: 0, outputEnd: 2 }],
      coveragePermille: 999, // lie
      contentHash: "deadbeef", // lie
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.coveragePermille, 200);
  assert.equal(res.body.contentHash, null); // AI summaries have no contentHash
});

test("citation offsets are validated in code points", async () => {
  const { app } = ctx;
  const source = await createSource(app);
  // Body has 3 code points; an end offset of 4 is out of range.
  const res = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "AI_SUMMARY",
      body: "😀AB",
      modelProvider: "acme",
      modelName: "m",
      generatedAt: new Date().toISOString(),
      inputBlockIds: [source.id],
      citations: [{ sourceBlockId: source.id, outputStart: 0, outputEnd: 4 }],
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.bodyCodePointLength, 3);
});

test("idempotency key replays the same response; different payload conflicts", async () => {
  const { app } = ctx;
  const headers = { "idempotency-key": "abc-123" };
  const payload = { kind: "READER_NOTE", body: "idempotent note" };

  const first = await inject(app, "POST", "/v1/submissions", {
    payload,
    headers,
  });
  assert.equal(first.status, 201);
  assert.equal(first.headers["idempotency-replayed"], "false");

  const replay = await inject(app, "POST", "/v1/submissions", {
    payload,
    headers,
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(
    replay.body.id,
    first.body.id,
    "same row returned, not a new one",
  );

  const conflict = await inject(app, "POST", "/v1/submissions", {
    payload: { kind: "READER_NOTE", body: "different body" },
    headers,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSE");
});

test("list pagination is stable across (createdAt, id) and cursors do not skip", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await inject(app, "POST", "/v1/submissions", {
        payload: { kind: "READER_NOTE", body: `note ${i}` },
      });
      ids.push(r.body.id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const url =
        `/v1/submissions?limit=3` + (cursor ? `&cursor=${cursor}` : "");
      const page = await inject(app, "GET", url);
      assert.equal(page.status, 200);
      for (const item of page.body.items) {
        collected.push(item.id);
      }
      if (!page.body.hasMore) {
        cursor = null;
        break;
      }
      cursor = page.body.nextCursor;
    }
    assert.deepEqual(collected, ids, "every row seen exactly once, in order");
  } finally {
    await localCtx.close();
  }
});

test("kind filter narrows the list", async () => {
  const localCtx = await createTestContext();
  try {
    const { app } = localCtx;
    await createSource(app);
    await inject(app, "POST", "/v1/submissions", {
      payload: { kind: "READER_NOTE", body: "note" },
    });
    const sources = await inject(
      app,
      "GET",
      "/v1/submissions?kind=SOURCE_EXCERPT",
    );
    assert.equal(sources.body.items.length, 1);
    assert.equal(sources.body.items[0].kind, "SOURCE_EXCERPT");
  } finally {
    await localCtx.close();
  }
});
