/**
 * Synthetic data generator. Creates a small, self-consistent corpus:
 *   - source excerpts (with versions + page numbers and server-computed hashes),
 *   - reader notes and editor summaries,
 *   - AI summaries with real per-claim citations — one comfortably above the
 *     policy-v1 threshold and one deliberately below it,
 * then publishes the passing set so there is a publication with an immutable
 * snapshot to inspect. No real models are called and nothing is fetched.
 */
import { PrismaClient } from "@prisma/client";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";

// The seed is a script, not a server; keep its Fastify instance quiet.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });
  const app = await buildApp(prisma);
  await app.ready();

  const post = async (url: string, payload: unknown): Promise<any> => {
    const res = await app.inject({
      method: "POST",
      url,
      payload: payload as object,
    });
    const body = res.body ? JSON.parse(res.body) : undefined;
    if (res.statusCode >= 300) {
      throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
    }
    return body;
  };

  const codePoints = (s: string): number => Array.from(s).length;

  // --- Source excerpts -------------------------------------------------------
  const source1 = await post("/v1/submissions", {
    kind: "SOURCE_EXCERPT",
    docKey: "article-42",
    body: "Photosynthesis converts light energy into chemical energy stored in glucose.",
    version: "2024-06-01",
    pageStart: 12,
    pageEnd: 12,
  });
  const source2 = await post("/v1/submissions", {
    kind: "SOURCE_EXCERPT",
    docKey: "article-42",
    // Includes an astral CJK character and an emoji to exercise Unicode paths.
    body: "光合作用把光能转化为化学能 🌱 stored for later use by the plant.",
    version: "2024-06-01",
    pageStart: 13,
    pageEnd: 14,
  });

  // --- Human content ---------------------------------------------------------
  await post("/v1/submissions", {
    kind: "READER_NOTE",
    docKey: "article-42",
    body: "I found the glucose explanation especially clear.",
  });
  await post("/v1/submissions", {
    kind: "EDITOR_SUMMARY",
    docKey: "article-42",
    body: "An accessible primer on how plants turn sunlight into stored energy.",
  });

  // --- AI summary that PASSES policy v1 (coverage >= 700) ---------------------
  const passBody =
    "Photosynthesis converts light energy into chemical energy stored in glucose.";
  const passingAi = await post("/v1/submissions", {
    kind: "AI_SUMMARY",
    docKey: "article-42",
    body: passBody,
    modelProvider: "synthetic-lab",
    modelName: "offline-summarizer-v1",
    generatedAt: new Date().toISOString(),
    inputBlockIds: [source1.id],
    citations: [
      {
        sourceBlockId: source1.id,
        outputStart: 0,
        outputEnd: codePoints(passBody),
        sourceStart: 0,
        sourceEnd: codePoints(source1.body),
      },
    ],
  });

  // --- AI summary that FAILS policy v1 (coverage < 700) -----------------------
  const failBody =
    "Plants are green and grow in many climates, and photosynthesis matters.";
  await post("/v1/submissions", {
    kind: "AI_SUMMARY",
    docKey: "article-42",
    body: failBody,
    modelProvider: "synthetic-lab",
    modelName: "offline-summarizer-v1",
    generatedAt: new Date().toISOString(),
    inputBlockIds: [source2.id],
    citations: [
      // Only a short slice is grounded, leaving coverage well below 700.
      { sourceBlockId: source2.id, outputStart: 60, outputEnd: 71 },
    ],
  });

  // --- Publish the passing set ----------------------------------------------
  const publication = await post("/v1/publications", {
    scope: "article-42",
    policyVersion: "v1",
    expectedRevision: 0,
    submissionIds: [source1.id, passingAi.id],
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        seeded: {
          sources: [source1.id, source2.id],
          passingAiSummary: passingAi.id,
          publication: {
            id: publication.id,
            scope: publication.scope,
            revision: publication.revision,
          },
        },
      },
      null,
      2,
    ),
  );

  await app.close();
  await prisma.$disconnect();
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
