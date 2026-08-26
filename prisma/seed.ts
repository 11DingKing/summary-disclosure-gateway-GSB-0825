/**
 * Synthetic seed data: exercises all four block kinds and one policy-v1
 * publication. No real model calls, no network fetches — AI provenance is
 * fixture metadata only. Idempotent: safe to run repeatedly.
 */
import { buildApp } from "../src/app";

async function main() {
  const app = await buildApp({ logger: false });

  const post = async (url: string, payload: Record<string, unknown>) => {
    const res = await app.inject({ method: "POST", url, payload });
    if (res.statusCode >= 300)
      throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
    return res.json() as Record<string, any>;
  };

  const excerptA = await post("/blocks", {
    kind: "SOURCE_EXCERPT",
    text: "The quick brown fox jumps over the lazy dog.",
    version: "1st-ed",
    pageNumber: 12,
    idempotencyKey: "seed-excerpt-a",
  });

  const excerptB = await post("/blocks", {
    kind: "SOURCE_EXCERPT",
    text: "Pack my box with five dozen liquor jugs.",
    version: "2nd-ed",
    pageNumber: 33,
    idempotencyKey: "seed-excerpt-b",
  });

  const note = await post("/blocks", {
    kind: "READER_NOTE",
    text: "Reader marginalia: both pangrams waste no letters.",
    idempotencyKey: "seed-note",
  });

  const editor = await post("/blocks", {
    kind: "EDITOR_SUMMARY",
    text: "Editor summary: chapter contrasts two classic pangrams.",
    idempotencyKey: "seed-editor",
  });

  // code points: "Fox jumps. Box jugs." (20 chars, 17 non-whitespace)
  // spans cover [0,10) and [11,20) -> 17/17 covered = 1000 permille.
  const summaryText = "Fox jumps. Box jugs.";
  const aiSummary = await post("/blocks", {
    kind: "AI_SUMMARY",
    text: summaryText,
    modelProvider: "synthetic-fixtures",
    modelName: "pangram-summarizer-0",
    generatedAt: new Date().toISOString(),
    inputSourceBlockIds: [excerptA.id, excerptB.id],
    citations: [
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
    idempotencyKey: "seed-ai-summary",
  });

  const meta = (await app.inject({ method: "GET", url: "/meta" })).json() as {
    revision: number;
  };
  const publication = await post("/publications", {
    summaryBlockId: aiSummary.id,
    policyVersion: "v1",
    expectedRevision: meta.revision,
    idempotencyKey: "seed-publication",
  });

  console.log("Seeded blocks:");
  console.log(`  SOURCE_EXCERPT A ${excerptA.id}`);
  console.log(`  SOURCE_EXCERPT B ${excerptB.id}`);
  console.log(`  READER_NOTE      ${note.id}`);
  console.log(`  EDITOR_SUMMARY   ${editor.id}`);
  console.log(
    `  AI_SUMMARY       ${aiSummary.id} (coverage ${aiSummary.coveragePermille}/1000)`,
  );
  console.log(
    `Publication:     ${publication.id} at revision ${publication.revision}`,
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
