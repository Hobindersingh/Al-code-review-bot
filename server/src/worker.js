import mongoose from 'mongoose';
import { Worker } from 'bullmq';
import { assertWorkerConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { QUEUE_NAME, createRedis } from './services/queue.js';
import { GitHubService } from './services/github.js';
import { createLlmClient } from './services/llm.js';
import { createProcessor } from './services/processor.js';
import { Review } from './models/Review.js';

const config = loadConfig();
assertWorkerConfig(config);
const logger = createLogger(config.logLevel);

await mongoose.connect(config.mongoUri);
await Review.init();

const openai = createLlmClient(config.llm);
const processor = createProcessor({ github: new GitHubService(config), openai, config, logger, Review });

const worker = new Worker(QUEUE_NAME, processor, {
  connection: createRedis(config.redisUrl),
  concurrency: config.worker.concurrency,
  limiter: { max: config.worker.ratePerMin, duration: 60_000 }, // global throttle protects OpenAI/GitHub quotas
});

worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'job failed'));
worker.on('error', (err) => logger.error({ err }, 'worker error'));
logger.info({ concurrency: config.worker.concurrency, provider: config.llm.provider, model: config.llm.model, maxRpm: config.llm.maxRpm }, 'worker started');
if (config.llm.provider === 'gemini') {
  logger.warn('Gemini free tier: Google may use prompts and responses to improve its products. Do not review private or confidential code on the free tier.');
}

async function shutdown(signal) {
  logger.info({ signal }, 'draining worker');
  await worker.close(); // waits for in-flight jobs
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
