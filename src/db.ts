import { PrismaClient } from "@prisma/client";

export type { PrismaClient } from "@prisma/client";

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  if (databaseUrl) {
    return new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
  }
  return new PrismaClient();
}

export const prisma = createPrismaClient();
