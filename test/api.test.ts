import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.prisma.publication.deleteMany();
  await app.prisma.block.deleteMany();
  await app.prisma.gatewayState.upsert({
    where: { id: 1 },
    create: { id: 1, revision: 0 },
    update: { revision: 0 },
  });
});

const post = (
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) => app.inject({ method: "POST", url, payload, headers });

const get = (url: string) => app.inject({ method: "GET", url });

const patch = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, payload });

async function makeExcerpt(text: string, extra: Record<string, unknown> = {}) {
  const res = await post("/blocks", {
    kind: "SOURCE_EXCERPT",
    text,
    version: "1st-ed",
    pageNumber: 7,
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function makeAiSummary(
  text: string,
  citations: Array<Record<string, unknown>>,
  inputSourceBlockIds: string[],
  extra: Record<string, unknown> = {},
) {
  return post("/blocks", {
    kind: "AI_SUMMARY",
    text,
    modelProvider: "synthetic-fixtures",
    modelName: "fixture-1",
    generatedAt: new Date().toISOString(),
    inputSourceBlockIds,
    citations,
    ...extra,
  });
}

async function currentRevision(): Promise<number> {
  return ((await get("/meta")).json() as { revision: number }).revision;
}

describe("block creation: kind-specific provenance gates", () => {
  it("rejects SOURCE_EXCERPT without version/pageNumber", async () => {
    const res = await post("/blocks", {
      kind: "SOURCE_EXCERPT",
      text: "excerpt",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("MISSING_REQUIRED_FIELDS");
    expect(body.error.details.fields).toEqual(["version", "pageNumber"]);
  });

  it("accepts READER_NOTE and EDITOR_SUMMARY with just text", async () => {
    for (const kind of ["READER_NOTE", "EDITOR_SUMMARY"]) {
      const res = await post("/blocks", { kind, text: `${kind} body` });
      expect(res.statusCode).toBe(201);
      expect(res.json().kind).toBe(kind);
    }
  });

  it("rejects AI_SUMMARY missing model provenance", async () => {
    const res = await post("/blocks", { kind: "AI_SUMMARY", text: "summary" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fields).toEqual([
      "modelProvider",
      "modelName",
      "generatedAt",
      "inputSourceBlockIds",
      "citations",
    ]);
  });

  it("rejects citations pointing outside inputSourceBlockIds", async () => {
    const excerpt = await makeExcerpt("source text");
    const res = await makeAiSummary(
      "sum",
      [{ start: 0, end: 3, sourceBlockId: "not-listed", sourceHash: "x" }],
      [excerpt.id],
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CITATION_SOURCE_NOT_LISTED");
  });

  it("rejects unknown input source blocks", async () => {
    const res = await makeAiSummary(
      "sum",
      [{ start: 0, end: 3, sourceBlockId: "missing-id", sourceHash: "x" }],
      ["missing-id"],
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNKNOWN_SOURCE_BLOCK");
  });

  it("rejects out-of-bounds citation spans (code-point based)", async () => {
    const excerpt = await makeExcerpt("source text");
    const res = await makeAiSummary(
      "摘要😀很好", // 5 code points
      [
        {
          start: 0,
          end: 6,
          sourceBlockId: excerpt.id,
          sourceHash: excerpt.contentHash,
        },
      ],
      [excerpt.id],
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CITATION_SPAN");
    expect(res.json().error.details.textLength).toBe(5);
  });

  it("ignores any client-supplied coveragePermille and computes it server-side", async () => {
    const excerpt = await makeExcerpt("source text");
    // extra fields are rejected by the schema -> provenance cannot be forged
    const res = await makeAiSummary(
      "摘要😀很好",
      [
        {
          start: 0,
          end: 3,
          sourceBlockId: excerpt.id,
          sourceHash: excerpt.contentHash,
        },
      ],
      [excerpt.id],
      { coveragePermille: 1000 },
    );
    expect(res.statusCode).toBe(400);

    const ok = await makeAiSummary(
      "摘要😀很好",
      [
        {
          start: 0,
          end: 3,
          sourceBlockId: excerpt.id,
          sourceHash: excerpt.contentHash,
        },
      ],
      [excerpt.id],
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.json().coveragePermille).toBe(600); // 3 of 5 code points
  });
});

describe("idempotency", () => {
  it("replays the same payload with the same key -> 200 and same id", async () => {
    const payload = {
      kind: "READER_NOTE",
      text: "note",
      idempotencyKey: "key-1",
    };
    const first = await post("/blocks", payload);
    const second = await post("/blocks", payload);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect((await get("/blocks")).json().items).toHaveLength(1);
  });

  it("accepts the Idempotency-Key header as well", async () => {
    const payload = { kind: "READER_NOTE", text: "header note" };
    const first = await post("/blocks", payload, {
      "idempotency-key": "hdr-1",
    });
    const second = await post("/blocks", payload, {
      "idempotency-key": "hdr-1",
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it("rejects key reuse with a different payload", async () => {
    await post("/blocks", {
      kind: "READER_NOTE",
      text: "one",
      idempotencyKey: "key-2",
    });
    const res = await post("/blocks", {
      kind: "READER_NOTE",
      text: "two",
      idempotencyKey: "key-2",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("cursor pagination", () => {
  it("walks all pages in stable createdAt,id order without duplicates", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await makeExcerpt(`excerpt ${i}`)).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = cursor
        ? `/blocks?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "/blocks?limit=2";
      const body: { items: Array<{ id: string }>; nextCursor: string | null } =
        (await get(url)).json();
      seen.push(...body.items.map((b) => b.id));
      cursor = body.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(ids); // insertion order == createdAt,id ascending
  });

  it("filters by kind and rejects malformed cursors", async () => {
    await makeExcerpt("a");
    await post("/blocks", { kind: "READER_NOTE", text: "n" });
    const filtered = (await get("/blocks?kind=READER_NOTE")).json();
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].kind).toBe("READER_NOTE");

    const bad = await get("/blocks?cursor=%%%not-base64%%%");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_CURSOR");
  });
});

describe("publication under policy v1", () => {
  async function setupPublishable() {
    const excerptA = await makeExcerpt(
      "The quick brown fox jumps over the lazy dog.",
    );
    const excerptB = await makeExcerpt(
      "Pack my box with five dozen liquor jugs.",
    );
    const text = "Fox jumps. Box jugs."; // 17 non-ws chars, spans below cover all 17 -> 1000
    const summary = (
      await makeAiSummary(
        text,
        [
          {
            start: 0,
            end: 10,
            sourceBlockId: excerptA.id,
            sourceHash: excerptA.contentHash,
          },
          {
            start: 11,
            end: 20,
            sourceBlockId: excerptB.id,
            sourceHash: excerptB.contentHash,
          },
        ],
        [excerptA.id, excerptB.id],
      )
    ).json();
    return { excerptA, excerptB, summary };
  }

  it("publishes and freezes an immutable snapshot", async () => {
    const { summary, excerptA } = await setupPublishable();
    const revision = await currentRevision();
    const res = await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: revision,
    });
    expect(res.statusCode).toBe(201);
    const pub = res.json();
    expect(pub.coveragePermille).toBe(1000);
    expect(pub.revision).toBe(revision);
    expect(pub.snapshot.summary.id).toBe(summary.id);
    expect(pub.snapshot.sources).toHaveLength(2);

    // mutate the source afterwards: history must not be rewritten
    await patch(`/blocks/${excerptA.id}`, {
      text: "Completely rewritten source text.",
    });
    const fetched = (await get(`/publications/${pub.id}`)).json();
    const snapSource = fetched.snapshot.sources.find(
      (s: { id: string }) => s.id === excerptA.id,
    );
    expect(snapSource.text).toBe(
      "The quick brown fox jumps over the lazy dog.",
    );
    expect(snapSource.contentHash).toBe(excerptA.contentHash);
    const liveSource = (await get(`/blocks/${excerptA.id}`)).json();
    expect(liveSource.text).toBe("Completely rewritten source text.");
  });

  it("rejects coverage below 700 permille with a machine-readable reason", async () => {
    const excerpt = await makeExcerpt("source");
    const summary = (
      await makeAiSummary(
        "摘要😀很好", // 5 code points
        [
          {
            start: 0,
            end: 3,
            sourceBlockId: excerpt.id,
            sourceHash: excerpt.contentHash,
          },
        ],
        [excerpt.id],
      )
    ).json();
    const res = await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: await currentRevision(),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("POLICY_REJECTION");
    expect(body.error.details.reasons).toContainEqual({
      code: "COVERAGE_BELOW_THRESHOLD",
      required: 700,
      actual: 600,
    });
    expect(await app.prisma.publication.count()).toBe(0);
  });

  it("rejects when a source hash went stale after the source changed", async () => {
    const excerpt = await makeExcerpt("original source text");
    const text = "Summary of original.";
    const len = Array.from(text).length;
    const summary = (
      await makeAiSummary(
        text,
        [
          {
            start: 0,
            end: len,
            sourceBlockId: excerpt.id,
            sourceHash: excerpt.contentHash,
          },
        ],
        [excerpt.id],
      )
    ).json();

    await patch(`/blocks/${excerpt.id}`, { text: "tampered source text" });

    const res = await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: await currentRevision(),
    });
    expect(res.statusCode).toBe(422);
    const reasons = res.json().error.details.reasons;
    expect(reasons).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_HASH_MISMATCH",
        sourceBlockId: excerpt.id,
      }),
    );
  });

  it("rejects overlapping/duplicate spans that inflate coverage (unicode case)", async () => {
    const excerpt = await makeExcerpt("source");
    // 5 code points; one span covers 3, its duplicate adds nothing -> 600 < 700
    const citation = {
      start: 0,
      end: 3,
      sourceBlockId: excerpt.id,
      sourceHash: excerpt.contentHash,
    };
    const summary = (
      await makeAiSummary("摘要😀很好", [citation, citation], [excerpt.id])
    ).json();
    const res = await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: await currentRevision(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.reasons[0]).toEqual({
      code: "COVERAGE_BELOW_THRESHOLD",
      required: 700,
      actual: 600,
    });
  });

  it("rejects a wrong expectedRevision", async () => {
    const { summary } = await setupPublishable();
    const res = await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: (await currentRevision()) + 10,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("REVISION_MISMATCH");
  });

  it("rejects unsupported policy versions", async () => {
    const { summary } = await setupPublishable();
    const res = await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v2",
      expectedRevision: await currentRevision(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNSUPPORTED_POLICY_VERSION");
  });

  it("rejects publishing non-AI_SUMMARY blocks", async () => {
    const excerpt = await makeExcerpt("source");
    const res = await post("/publications", {
      summaryBlockId: excerpt.id,
      policyVersion: "v1",
      expectedRevision: await currentRevision(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_SUMMARY_KIND");
  });

  it("allows exactly one winner under concurrent publish with the same expectedRevision", async () => {
    const { summary } = await setupPublishable();
    const revision = await currentRevision();
    const payload = {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: revision,
    };
    const [r1, r2] = await Promise.all([
      post("/publications", payload),
      post("/publications", payload),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect((r1.statusCode === 409 ? r1 : r2).json().error.code).toBe(
      "REVISION_MISMATCH",
    );
    expect(await app.prisma.publication.count()).toBe(1);
  });

  it("supports idempotent publish retries", async () => {
    const { summary } = await setupPublishable();
    const payload = {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: await currentRevision(),
      idempotencyKey: "pub-1",
    };
    const first = await post("/publications", payload);
    const second = await post("/publications", payload);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await app.prisma.publication.count()).toBe(1);
  });

  it("paginates publications with cursors", async () => {
    const { summary } = await setupPublishable();
    await post("/publications", {
      summaryBlockId: summary.id,
      policyVersion: "v1",
      expectedRevision: await currentRevision(),
    });
    const list = (await get("/publications?limit=1")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].snapshot).toBeUndefined(); // list view is metadata only
    expect(list.nextCursor).toBeNull();
  });
});
