import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved relative to the compiled/loaded module location. */
export const projectRoot = path.resolve(here, "..");

function parsePort(value: string | undefined): number {
  const n = Number(value ?? 3000);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return n;
}

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
}

export const config: Config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: parsePort(process.env.PORT),
  databaseUrl:
    process.env.DATABASE_URL ??
    `file:${path.join(projectRoot, "prisma", "dev.db")}`,
};
