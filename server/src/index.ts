import { createApp } from './app';
import { migrate } from './db';
import { seed } from './seed';

const PORT = Number(process.env.PORT || 4000);

async function main() {
  await migrate();
  if (process.env.SEED !== 'false') await seed();
  createApp().listen(PORT, () => console.log(`Supplier.id API listening on http://localhost:${PORT}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
