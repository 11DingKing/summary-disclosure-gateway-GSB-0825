import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import type { CreateSubmissionBody, PublishBody } from '../src/types.js';
import { codePointLength } from '../src/lib/unicode.js';

export interface TestHarness {
  app: FastifyInstance;
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

export async function setupHarness(): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'sdg-test-'));
  const dbFile = join(dir, 'test.db');
  const dbUrl = `file:${dbFile}?_busy_timeout=10000&_journal_mode=WAL`;

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    cwd: process.cwd(),
    stdio: 'pipe',
  });

  const prisma = createPrismaClient(dbUrl);
  const app = await buildApp(prisma);

  return {
    app,
    prisma,
    cleanup: async () => {
      await app.close();
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function inject(
  app: FastifyInstance,
  options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method: options.method,
    url: options.url,
    payload: options.payload as any,
    headers: options.headers,
  });
  let body: any;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

export function createSourceExcerpt(
  app: FastifyInstance,
  content: string,
  opts: { version?: string; page?: string; idempotencyKey?: string } = {},
) {
  const payload: CreateSubmissionBody = {
    kind: 'SOURCE_EXCERPT',
    content,
    version: opts.version ?? '1.0',
    page: opts.page ?? '1',
  };
  return inject(app, {
    method: 'POST',
    url: '/v1/submissions',
    payload,
    headers: opts.idempotencyKey
      ? { 'idempotency-key': opts.idempotencyKey }
      : undefined,
  });
}

export function createReaderNote(app: FastifyInstance, content: string) {
  return inject(app, {
    method: 'POST',
    url: '/v1/submissions',
    payload: { kind: 'READER_NOTE', content },
  });
}

export function createEditorSummary(app: FastifyInstance, content: string) {
  return inject(app, {
    method: 'POST',
    url: '/v1/submissions',
    payload: { kind: 'EDITOR_SUMMARY', content },
  });
}

export function createAiSummary(
  app: FastifyInstance,
  opts: {
    content: string;
    sourceIds: string[];
    citations: Array<{ sourceBlockId: string; startOffset: number; endOffset: number }>;
    modelProvider?: string;
    modelName?: string;
    generatedAt?: string;
    idempotencyKey?: string;
  },
) {
  const payload: CreateSubmissionBody = {
    kind: 'AI_SUMMARY',
    content: opts.content,
    modelProvider: opts.modelProvider ?? 'test-provider',
    modelName: opts.modelName ?? 'test-model',
    generatedAt: opts.generatedAt ?? '2026-08-25T10:00:00.000Z',
    inputSourceBlockIds: opts.sourceIds,
    citations: opts.citations,
  };
  return inject(app, {
    method: 'POST',
    url: '/v1/submissions',
    payload,
    headers: opts.idempotencyKey
      ? { 'idempotency-key': opts.idempotencyKey }
      : undefined,
  });
}

export function publish(
  app: FastifyInstance,
  submissionId: string,
  opts: Partial<PublishBody> & { idempotencyKey?: string } = {},
) {
  const payload: PublishBody = {
    policyVersion: opts.policyVersion ?? 1,
    expectedRevision: opts.expectedRevision ?? 1,
  };
  return inject(app, {
    method: 'POST',
    url: `/v1/submissions/${submissionId}/publish`,
    payload,
    headers: opts.idempotencyKey
      ? { 'idempotency-key': opts.idempotencyKey }
      : undefined,
  });
}

export function getSubmission(app: FastifyInstance, id: string) {
  return inject(app, { method: 'GET', url: `/v1/submissions/${id}` });
}

export function patchSubmission(app: FastifyInstance, id: string, content: string) {
  return inject(app, {
    method: 'PATCH',
    url: `/v1/submissions/${id}`,
    payload: { content },
  });
}

export function getPublication(app: FastifyInstance, id: string) {
  return inject(app, { method: 'GET', url: `/v1/publications/${id}` });
}

export function listPublications(app: FastifyInstance, query = '') {
  return inject(app, { method: 'GET', url: `/v1/publications${query}` });
}

export function listSubmissions(app: FastifyInstance, query = '') {
  return inject(app, { method: 'GET', url: `/v1/submissions${query}` });
}

/**
 * Build a single citation spanning [0, codePointLength(content)) against the
 * given source block, covering every non-whitespace output character and
 * yielding a coveragePermille of 1000 when the source hash is valid.
 */
export function fullCoverageCitations(
  content: string,
  sourceId: string,
): Array<{ sourceBlockId: string; startOffset: number; endOffset: number }> {
  return [{ sourceBlockId: sourceId, startOffset: 0, endOffset: codePointLength(content) }];
}
