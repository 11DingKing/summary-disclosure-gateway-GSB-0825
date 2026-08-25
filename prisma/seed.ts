/**
 * Synthetic data seed.
 *
 * Run with: npm run seed
 *
 * Creates two source excerpts, a reader note, an editor summary, a fully-cited
 * AI summary that passes policy v1, and an immutable publication snapshot.
 */
import { PrismaClient } from '@prisma/client';
import { AI_SUMMARY, EDITOR_SUMMARY, READER_NOTE, SOURCE_EXCERPT } from '../src/constants.js';
import { computeContentHash } from '../src/lib/hash.js';
import {
  buildSnapshot,
  coverageForSubmission,
  loadSourceBlocksMap,
} from '../src/lib/serialize.js';
import { codePointLength } from '../src/lib/unicode.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('Resetting synthetic data...');
  await prisma.publication.deleteMany();
  await prisma.citationSpan.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.submission.deleteMany();

  const source1Content =
    'Photosynthesis converts light energy into chemical energy stored in glucose. The process occurs in chloroplasts and releases oxygen as a byproduct.';
  const source2Content =
    "Mitochondria generate most of the cell's supply of adenosine triphosphate, used as a source of chemical energy.";

  const source1 = await prisma.submission.create({
    data: {
      kind: SOURCE_EXCERPT,
      content: source1Content,
      version: '1.0',
      page: '42',
      contentHash: computeContentHash(source1Content),
    },
  });

  const source2 = await prisma.submission.create({
    data: {
      kind: SOURCE_EXCERPT,
      content: source2Content,
      version: '2.3',
      page: 'xii',
      contentHash: computeContentHash(source2Content),
    },
  });

  await prisma.submission.create({
    data: {
      kind: READER_NOTE,
      content:
        'Reader note: I want to cross-check the ATP yield figure against the primary paper.',
    },
  });

  await prisma.submission.create({
    data: {
      kind: EDITOR_SUMMARY,
      content:
        'Editor summary: This chapter contrasts energy capture in chloroplasts with energy release in mitochondria.',
    },
  });

  const aiContent =
    'Photosynthesis stores energy in glucose inside chloroplasts, while mitochondria produce ATP to power the cell. Both organelles transform energy for cellular use.';
  const aiLength = codePointLength(aiContent);

  // Split the AI output at a code-point boundary on a space so the two spans
  // cover every non-whitespace character without a gap (coverage 1000).
  const approximateMid = Math.floor(aiLength / 2);
  let split = approximateMid;
  const codePoints = Array.from(aiContent);
  while (split < aiLength && codePoints[split] !== ' ') split++;
  if (split >= aiLength) split = approximateMid;

  const generatedAt = new Date('2026-08-25T10:00:00.000Z');
  const aiSummary = await prisma.submission.create({
    data: {
      kind: AI_SUMMARY,
      content: aiContent,
      modelProvider: 'synthetic-test-provider',
      modelName: 'athena-summary-1',
      generatedAt,
      inputSourceBlockIds: JSON.stringify([source1.id, source2.id]),
    },
  });

  await prisma.citationSpan.createMany({
    data: [
      {
        submissionId: aiSummary.id,
        sourceBlockId: source1.id,
        startOffset: 0,
        endOffset: split,
        citedHash: source1.contentHash as string,
      },
      {
        submissionId: aiSummary.id,
        sourceBlockId: source2.id,
        startOffset: split,
        endOffset: aiLength,
        citedHash: source2.contentHash as string,
      },
    ],
  });

  const citations = await prisma.citationSpan.findMany({
    where: { submissionId: aiSummary.id },
  });
  const sourceBlocks = await loadSourceBlocksMap(prisma, [
    source1.id,
    source2.id,
  ]);
  const coverage = coverageForSubmission(aiSummary, citations, sourceBlocks);
  console.log(`AI summary coveragePermille = ${coverage.coveragePermille}`);

  const publishedAt = new Date('2026-08-25T10:05:00.000Z');
  const snapshot = buildSnapshot(
    aiSummary,
    citations,
    sourceBlocks,
    coverage,
    1,
    publishedAt,
  );
  await prisma.publication.create({
    data: {
      submissionId: aiSummary.id,
      policyVersion: 1,
      revision: aiSummary.revision,
      coveragePermille: coverage.coveragePermille,
      sourceHashesValid: coverage.invalidCitations.length === 0,
      snapshot: JSON.stringify(snapshot),
      publishedAt,
    },
  });

  // An AI summary with only a small citation span. It is stored but will be
  // rejected by policy v1 on publish (coverage well below 700).
  const weakContent =
    'This is a longer AI summary that makes many claims but only cites a single small phrase, so its citation coverage is far below the policy threshold and it cannot be published as-is.';
  const weakLength = codePointLength(weakContent);
  const weakSummary = await prisma.submission.create({
    data: {
      kind: AI_SUMMARY,
      content: weakContent,
      modelProvider: 'synthetic-test-provider',
      modelName: 'athena-summary-1',
      generatedAt,
      inputSourceBlockIds: JSON.stringify([source1.id]),
    },
  });
  await prisma.citationSpan.create({
    data: {
      submissionId: weakSummary.id,
      sourceBlockId: source1.id,
      startOffset: 0,
      endOffset: Math.min(4, weakLength),
      citedHash: source1.contentHash as string,
    },
  });

  console.log('Seed complete.');
  console.log(
    JSON.stringify(
      {
        source1: source1.id,
        source2: source2.id,
        aiSummary: aiSummary.id,
        weakSummary: weakSummary.id,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
