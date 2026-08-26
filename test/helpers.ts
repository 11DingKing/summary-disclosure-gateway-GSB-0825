import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

// Keep test output readable: silence Fastify's per-request logging.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  close: () => Promise<void>;
}

/**
 * Spin up a fully isolated gateway instance backed by a throwaway SQLite file.
 * Each test gets its own database (migrated via `prisma migrate deploy`) so
 * suites never contend for shared state.
 */
export async function createTestContext(): Promise<TestContext> {
  const dir = mkdtempSync(path.join(tmpdir(), "sdg-test-"));
  const dbPath = path.join(dir, "test.db");
  const databaseUrl = `file:${dbPath}`;

  execFileSync(
    path.join(projectRoot, "node_modules", ".bin", "prisma"),
    ["migrate", "deploy"],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore",
    },
  );

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const app = await buildApp(prisma);
  await app.ready();

  return {
    app,
    prisma,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Convenience wrapper around app.inject returning parsed JSON + status. */
export async function inject(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    payload: options.payload as object | undefined,
    headers: options.headers,
  });
  let body: unknown = undefined;
  const text = res.body;
  if (text && text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.statusCode, body, headers: res.headers };
}

/** Create a SOURCE_EXCERPT and return its serialized form. */
export async function createSource(
  app: FastifyInstance,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const res = await inject(app, "POST", "/v1/submissions", {
    payload: {
      kind: "SOURCE_EXCERPT",
      body: "The quick brown fox jumps over the lazy dog.",
      version: "v1",
      pageStart: 1,
      pageEnd: 1,
      ...overrides,
    },
  });
  if (res.status !== 201) {
    throw new Error(`createSource failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}
