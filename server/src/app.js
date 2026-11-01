import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { apiKeyAuth } from './middleware/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ config, logger, webhookRouter, apiRouter, healthCheck }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());

  // Webhook first, BEFORE any JSON body parser: signature verification needs the raw bytes.
  app.use('/webhook', webhookRouter);

  app.get('/health', async (_req, res) => {
    const checks = await healthCheck();
    res.status(checks.ok ? 200 : 503).json(checks);
  });

  app.use('/api', cors({ origin: config.corsOrigin }), rateLimit({ windowMs: 60_000, limit: 300 }), apiKeyAuth(config.dashboardApiKey), express.json({ limit: '10kb' }), apiRouter);

  const dist = path.resolve(here, '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api|webhook|health).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'invalid request', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    logger.error({ err }, 'unhandled error');
    return res.status(500).json({ error: 'internal error' });
  });

  return app;
}
