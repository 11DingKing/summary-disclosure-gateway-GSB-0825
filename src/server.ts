import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'Failed to start server');
  process.exit(1);
}
