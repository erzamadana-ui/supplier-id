import bcrypt from 'bcryptjs';
import { pool, q, maybe, one } from './db';

/** Akun demo (idempoten). Kata sandi demo: Password123 — ganti sebelum produksi. */
export const DEMO_ACCOUNTS = [
  { email: 'admin@supplier.id', name: 'Admin Supplier.id', role: 'ADMIN', org: null },
  { email: 'finance@supplier.id', name: 'Finance Approver', role: 'ADMIN', org: null },
  { email: 'tani@supplier.id', name: 'Pak Rahmat', role: 'SUPPLIER', org: { name: 'Kelompok Tani Sumber Rezeki', kind: 'KELOMPOK_TANI', tax: 'NON_PKP', region: 'Padang, Sumatera Barat' } },
  { email: 'ternak@supplier.id', name: 'Bu Sari', role: 'SUPPLIER', org: { name: 'PT Ternak Nusantara', kind: 'PETERNAK', tax: 'PKP', region: 'Pekanbaru, Riau' } },
  { email: 'nelayan@supplier.id', name: 'Pak Yusuf', role: 'SUPPLIER', org: { name: 'Koperasi Nelayan Batam', kind: 'KOPERASI', tax: 'NON_PKP', region: 'Batam, Kepulauan Riau' } },
  { email: 'buyer@supplier.id', name: 'Rina (Procurement)', role: 'BUYER', org: { name: 'PT Resto Sumatera Group', tax: 'PKP', region: 'Pekanbaru, Riau' } },
  { email: 'hotel@supplier.id', name: 'Dedi (Purchasing)', role: 'BUYER', org: { name: 'Hotel Bukittinggi Indah', tax: 'PKP', region: 'Bukittinggi, Sumatera Barat' } },
] as const;
export const DEMO_PASSWORD = 'Password123';

export async function seed() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const a of DEMO_ACCOUNTS) {
    if (await maybe(pool, 'SELECT 1 FROM users WHERE email=$1', [a.email])) continue;
    let orgId: string | null = null;
    if (a.org) {
      const o = await one(pool,
        `INSERT INTO organizations(type, name, supplier_kind, tax_status, region, verified, bank_account) VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
        [a.role, a.org.name, (a.org as any).kind ?? null, a.org.tax, a.org.region, a.role === 'SUPPLIER' ? 'BRI 1234-01-000000-50-1' : null]);
      orgId = o.id;
    }
    await q(pool, `INSERT INTO users(email, password_hash, name, role, org_id) VALUES ($1,$2,$3,$4,$5)`, [a.email, hash, a.name, a.role, orgId]);
  }
  if (!(await maybe(pool, `SELECT 1 FROM settings WHERE key='fulfillment.pickup_lead_hours'`))) {
    await q(pool, `INSERT INTO settings(key, value, description) VALUES ('fulfillment.pickup_lead_hours','48','Janji pickup (jam) sejak konfirmasi — dipakai metrik late fulfillment')`);
  }
}

if (require.main === module) {
  seed().then(() => { console.log('seeded'); return pool.end(); });
}
