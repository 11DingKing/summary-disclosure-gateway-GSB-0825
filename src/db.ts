import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

/**
 * Shared PrismaClient instance for the running server. Tests build their own
 * client against an isolated database file, so this is only used by the
 * long-lived process entrypoints.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
});
