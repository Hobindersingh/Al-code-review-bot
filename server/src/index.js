import mongoose from 'mongoose';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRedis, createReviewQueue } from './services/queue.js';
import { createIdempotency } from './services/idempotency.js';
import { createWebhookRouter } from './routes/webhook.js';
import { createApiRouter } from './routes/api.js';
import { createApp } from './app.js';
import { Review } from './models/Review.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

await mongoose.connect(config.mongoUri);
await Review.init(); // make sure the unique index (idempotency layer 3) exists before taking traffic

const redis = createRedis(config.redisUrl);
const queue = createReviewQueue(redis.duplicate());

const app = createApp({
  config,
  logger,
  webhookRouter: createWebhookRouter({ secret: config.webhookSecret, queue, idempotency: createIdempotency(redis), logger }),
  apiRouter: createApiRouter(),
  healthCheck: async () => {
    const mongo = mongoose.connection.readyState === 1;
    const redisOk = await redis.ping().then((r) => r === 'PONG').catch(() => false);
    return { ok: mongo && redisOk, mongo, redis: redisOk };
  },
});

const server = app.listen(config.port, () => logger.info({ port: config.port }, 'api listening'));

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([queue.close(), mongoose.disconnect()]);
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
