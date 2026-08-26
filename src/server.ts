import { buildApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";

async function main(): Promise<void> {
  const app = await buildApp(prisma);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    await prisma.$disconnect();
    process.exit(1);
  }
}

void main();
