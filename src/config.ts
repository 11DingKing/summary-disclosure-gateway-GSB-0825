import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

function parsePort(value: string | undefined): number {
  const n = Number(value ?? 3000);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return n;
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: parsePort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL ?? `file:${path.join(projectRoot, 'prisma', 'dev.db')}`,
};
