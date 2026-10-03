import bcrypt from 'bcryptjs';
import { pool, q, maybe, one } from './db';

/** Akun demo (idempoten). Kata sandi demo: Password123 — ganti sebelum produksi. */
export const DEMO_ACCOUNTS = [
  { email: 'admin@supplier.id', name: 'Admin Supplier.id', role: 'ADMIN', org: null, adminRole: 'OWNER' },
  { email: 'finance@supplier.id', name: 'Finance Approver', role: 'ADMIN', org: null, adminRole: 'FINANCE_CHECKER' },
  { email: 'maker@supplier.id', name: 'Finance Maker', role: 'ADMIN', org: null, adminRole: 'FINANCE_MAKER' },
  { email: 'ops@supplier.id', name: 'Ops & Dispatcher', role: 'ADMIN', org: null, adminRole: 'OPS', permissions: ['shipments.manage', 'couriers.manage', 'scan'] },
  { email: 'cs@supplier.id', name: 'Customer Service', role: 'ADMIN', org: null, adminRole: 'CS' },
  { email: 'kurir@supplier.id', name: 'Kurir Andi', role: 'COURIER', org: { name: 'Supplier-ID Delivery', tax: 'NON_PKP', region: 'Pekanbaru, Riau', type: 'LOGISTICS' } },
  { email: 'warga@supplier.id', name: 'Ibu Wati', role: 'BUYER', org: { name: 'Ibu Wati', tax: 'NON_PKP', region: 'Pekanbaru, Riau', buyerKind: 'INDIVIDU' } },
  { email: 'tani@supplier.id', name: 'Pak Rahmat', role: 'SUPPLIER', org: { name: 'Kelompok Tani Sumber Rezeki', kind: 'KELOMPOK_TANI', tax: 'NON_PKP', region: 'Padang, Sumatera Barat' } },
  { email: 'ternak@supplier.id', name: 'Bu Sari', role: 'SUPPLIER', org: { name: 'PT Ternak Nusantara', kind: 'PETERNAK', tax: 'PKP', region: 'Pekanbaru, Riau' } },
  { email: 'nelayan@supplier.id', name: 'Pak Yusuf', role: 'SUPPLIER', org: { name: 'Koperasi Nelayan Batam', kind: 'KOPERASI', tax: 'NON_PKP', region: 'Batam, Kepulauan Riau' } },
  { email: 'buyer@supplier.id', name: 'Rina (Procurement)', role: 'BUYER', org: { name: 'PT Resto Sumatera Group', tax: 'PKP', region: 'Pekanbaru, Riau' } },
  { email: 'hotel@supplier.id', name: 'Dedi (Purchasing)', role: 'BUYER', org: { name: 'Hotel Bukittinggi Indah', tax: 'PKP', region: 'Bukittinggi, Sumatera Barat' } },
] as const;
export const DEMO_PASSWORD = 'Password123';

export async function seed() {
  // Admin produksi dari environment (ADMIN_EMAIL + ADMIN_PASSWORD) — tidak pernah memakai sandi demo
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const ex = await maybe(pool, 'SELECT id FROM users WHERE email=$1', [process.env.ADMIN_EMAIL]);
    const h = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    if (!ex) await q(pool, `INSERT INTO users(email, password_hash, name, role) VALUES ($1,$2,$3,'ADMIN')`, [process.env.ADMIN_EMAIL, h, process.env.ADMIN_NAME || 'Admin Supplier.id']);
  }
  if (!(await maybe(pool, `SELECT 1 FROM settings WHERE key='fulfillment.pickup_lead_hours'`))) {
    await q(pool, `INSERT INTO settings(key, value, description) VALUES ('fulfillment.pickup_lead_hours','48','Janji pickup (jam) sejak konfirmasi — dipakai metrik late fulfillment')`);
  }
  if (process.env.SEED_DEMO === 'false') return;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const a of DEMO_ACCOUNTS) {
    if (await maybe(pool, 'SELECT 1 FROM users WHERE email=$1', [a.email])) continue;
    let orgId: string | null = null;
    if (a.org) {
      const type = (a.org as any).type ?? a.role;
      const o = (type === 'LOGISTICS' ? await maybe(pool, `SELECT id FROM organizations WHERE type='LOGISTICS' AND name=$1`, [a.org.name]) : null) ?? await one(pool,
        `INSERT INTO organizations(type, name, supplier_kind, tax_status, region, verified, bank_account, bank_name, bank_account_name, bank_verified_at, buyer_kind) VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,$9) RETURNING id`,
        [type, a.org.name, (a.org as any).kind ?? null, a.org.tax, a.org.region, a.role === 'SUPPLIER' ? '1234-01-000000-50-1' : null, a.role === 'SUPPLIER' ? 'BRI' : null, a.role === 'SUPPLIER' ? a.org.name : null, (a.org as any).buyerKind ?? (a.role === 'BUYER' ? 'BISNIS' : null)]);
      orgId = o.id;
    }
    await q(pool, `INSERT INTO users(email, password_hash, name, role, org_id, admin_role, permissions) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [a.email, hash, a.name, a.role, orgId, (a as any).adminRole ?? null, JSON.stringify((a as any).permissions ?? [])]);
  }
}

if (require.main === module) {
  seed().then(() => { console.log('seeded'); return pool.end(); });
}
