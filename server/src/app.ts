import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { authenticate, errorHandler } from './lib/http';
import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { evidenceRouter, UPLOAD_DIR } from './routes/evidence';
import { supplierRouter } from './routes/supplier';
import { rfqRouter } from './routes/rfq';
import { ordersRouter } from './routes/orders';
import { returnsRouter } from './routes/returns';
import { adminRouter } from './routes/admin';
import { cartRouter } from './routes/cart';
import { fulfillmentRouter } from './routes/fulfillment';
import { courierRouter } from './routes/courier';
import { financeRouter } from './routes/finance';
import { opsRouter } from './routes/ops';

/** Rate limit sederhana in-memory (per instance) untuk endpoint auth; di serverless hanya pembatas lunak — WAF/provider limit tetap disarankan. */
const hits = new Map<string, { n: number; t: number }>();
function authRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = `${req.ip}:${req.path}`; const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > 60_000) hits.set(key, { n: 1, t: now });
  else if (++h.n > 30) return res.status(429).json({ error: 'RATE_LIMITED', details: 'Terlalu banyak percobaan; coba lagi dalam 1 menit' });
  next();
}

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors(origins.length ? { origin: origins } : {}));
  app.use(express.json({ limit: '5mb', verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(authenticate);

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'supplier-id', time: new Date().toISOString() }));
  app.use('/api/auth', authRateLimit, authRouter);
  app.use('/api', catalogRouter);
  app.use('/api/evidence', evidenceRouter);
  app.use('/api/supplier', supplierRouter);
  app.use('/api', rfqRouter);
  app.use('/api', ordersRouter);
  app.use('/api', returnsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', cartRouter);
  app.use('/api', fulfillmentRouter);
  app.use('/api', courierRouter);
  app.use('/api', financeRouter);
  app.use('/api', opsRouter);
  app.use('/uploads', express.static(UPLOAD_DIR));

  // serve web build jika ada (produksi single-process)
  const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/uploads).*/, (_req, res, next) => {
    res.sendFile(path.join(webDist, 'index.html'), (err) => (err ? next() : undefined));
  });

  app.use(errorHandler);
  return app;
}
