import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');
const prismaBin = path.join(projectRoot, 'node_modules', '.bin', 'prisma');

export interface TestContext {
  db: PrismaClient;
  app: FastifyInstance;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sdg-test-'));
  const databaseUrl = `file:${path.join(dir, 'test.db')}`;
  execFileSync(prismaBin, ['migrate', 'deploy'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const app = await buildApp(db);
  return {
    db,
    app,
    databaseUrl,
    cleanup: async () => {
      await app.close();
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
}

export async function api(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const res = await app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    headers,
  });
  let parsed: unknown;
  try {
    parsed = res.json();
  } catch {
    parsed = res.body;
  }
  return {
    status: res.statusCode,
    body: parsed,
    headers: res.headers as Record<string, string>,
  };
}

export function cpLen(text: string): number {
  return Array.from(text).length;
}

export const SOURCE_BODY =
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';

export function sourcePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'SOURCE_EXCERPT',
    docKey: 'doc-1',
    body: SOURCE_BODY,
    version: 'v1',
    pageStart: 12,
    pageEnd: 13,
    ...overrides,
  };
}

export function aiPayload(
  sourceId: string,
  body: string,
  spans: Array<{ outputStart: number; outputEnd: number }>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'AI_SUMMARY',
    docKey: 'doc-1',
    body,
    modelProvider: 'acme-ai',
    modelName: 'model-x1',
    generatedAt: '2026-08-25T09:00:00.000Z',
    inputBlockIds: [sourceId],
    citations: spans.map((span) => ({ sourceBlockId: sourceId, ...span })),
    ...overrides,
  };
}

export function publishPayload(
  submissionIds: string[],
  expectedRevision: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scope: 'doc-1',
    policyVersion: 'v1',
    expectedRevision,
    submissionIds,
    ...overrides,
  };
}
