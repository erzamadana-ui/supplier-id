// Entry serverless Vercel: seluruh /api/* dan /uploads/* diarahkan ke sini (lihat vercel.json).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/app';
import { migrate } from '../src/db';
import { seed } from '../src/seed';

const app = createApp();
let ready: Promise<void> | null = null;
function init() {
  // migrasi + seed idempoten, dijalankan sekali per instance (cold start)
  if (!ready) ready = (async () => { await migrate(); await seed(); })().catch((e) => { ready = null; throw e; });
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await init();
  return (app as any)(req, res);
}
