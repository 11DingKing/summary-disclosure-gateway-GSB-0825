import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { sourceContentHash } from '../src/lib/hash.js';
import { codePointLength } from '../src/lib/coverage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl =
  process.env.DATABASE_URL ?? `file:${path.join(here, 'dev.db')}`;

const db = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

const DOC_KEY = 'doc:on-tyranny-2026';
const SCOPE = 'doc:on-tyranny-2026';

function sourceHash(version: string, revision: number, pageStart: number, pageEnd: number, body: string) {
  return sourceContentHash({ version, sourceRevision: revision, pageStart, pageEnd, body });
}

async function main() {
  await db.citation.deleteMany();
  await db.publication.deleteMany();
  await db.idempotencyRecord.deleteMany();
  await db.submission.deleteMany();

  const source1Body =
    'Power is not a means; it is an end. One does not establish a dictatorship in order to safeguard a revolution; one makes the revolution in order to establish the dictatorship.';
  const source2Body =
    'If you want a picture of the future, imagine a boot stamping on a human face — forever. The heresy of heresies was common sense.';

  const source1 = await db.submission.create({
    data: {
      kind: 'SOURCE_EXCERPT',
      docKey: DOC_KEY,
      body: source1Body,
      version: '1949-ed.1',
      pageStart: 263,
      pageEnd: 263,
      sourceRevision: 1,
      contentHash: sourceHash('1949-ed.1', 1, 263, 263, source1Body),
    },
  });

  const source2 = await db.submission.create({
    data: {
      kind: 'SOURCE_EXCERPT',
      docKey: DOC_KEY,
      body: source2Body,
      version: '1949-ed.1',
      pageStart: 267,
      pageEnd: 268,
      sourceRevision: 1,
      contentHash: sourceHash('1949-ed.1', 1, 267, 268, source2Body),
    },
  });

  await db.submission.create({
    data: {
      kind: 'READER_NOTE',
      docKey: DOC_KEY,
      body: '读到第三章时记下：权力在这里被描述为目的本身，而不是工具。需要对照第六章再看一遍。',
    },
  });

  await db.submission.create({
    data: {
      kind: 'EDITOR_SUMMARY',
      docKey: DOC_KEY,
      body: '编辑提要：本章核心论点是极权体制下权力自我维系的逻辑；出版方提示读者注意原文页码与版本。',
    },
  });

  const aiBody = `${source1Body} ${source2Body}`;
  const len1 = codePointLength(source1Body);
  const totalLen = codePointLength(aiBody);

  const ai = await db.submission.create({
    data: {
      kind: 'AI_SUMMARY',
      docKey: DOC_KEY,
      body: aiBody,
      modelProvider: 'synthetic-gateway-test',
      modelName: 'seed-model-x1',
      generatedAt: new Date('2026-08-25T09:00:00.000Z'),
      inputBlockIds: JSON.stringify([source1.id, source2.id]),
      citations: {
        create: [
          {
            sourceBlockId: source1.id,
            sourceContentHash: source1.contentHash ?? '',
            outputStart: 0,
            outputEnd: len1,
            sourceStart: 0,
            sourceEnd: len1,
            ordinal: 0,
          },
          {
            sourceBlockId: source2.id,
            sourceContentHash: source2.contentHash ?? '',
            outputStart: len1 + 1,
            outputEnd: totalLen,
            sourceStart: 0,
            sourceEnd: codePointLength(source2Body),
            ordinal: 1,
          },
        ],
      },
    },
    include: { citations: true },
  });

  const snapshotSubmissions = await db.submission.findMany({
    where: { id: { in: [source1.id, source2.id, ai.id] } },
    include: { citations: true },
  });

  const snapshot = {
    schemaVersion: 1,
    scope: SCOPE,
    revision: 1,
    policyVersion: 'v1',
    publishedAt: new Date().toISOString(),
    submissions: snapshotSubmissions.map((s) => ({
      id: s.id,
      kind: s.kind,
      docKey: s.docKey,
      body: s.body,
      version: s.version,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      sourceRevision: s.sourceRevision,
      contentHash: s.contentHash,
      modelProvider: s.modelProvider,
      modelName: s.modelName,
      generatedAt: s.generatedAt,
      inputBlockIds: s.inputBlockIds ? JSON.parse(s.inputBlockIds) : [],
      citations: s.citations.map((c) => ({
        id: c.id,
        sourceBlockId: c.sourceBlockId,
        sourceContentHash: c.sourceContentHash,
        outputStart: c.outputStart,
        outputEnd: c.outputEnd,
        sourceStart: c.sourceStart,
        sourceEnd: c.sourceEnd,
        ordinal: c.ordinal,
      })),
      coveragePermille: 1000,
    })),
    policy: {
      version: 'v1',
      minCoveragePermille: 700,
      aiResults: [
        {
          submissionId: ai.id,
          coveragePermille: 1000,
          coveredNonWhitespace: 0,
          totalNonWhitespace: 0,
          validCitationCount: 2,
          invalidCitationCount: 0,
        },
      ],
    },
  };

  const publication = await db.publication.create({
    data: {
      scope: SCOPE,
      revision: 1,
      policyVersion: 'v1',
      snapshot: JSON.stringify(snapshot),
    },
  });

  console.log(
    JSON.stringify(
      {
        seeded: {
          sourceExcerpts: [source1.id, source2.id],
          aiSummary: ai.id,
          publication: publication.id,
          scope: SCOPE,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
