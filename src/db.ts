import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

export const db = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
});
