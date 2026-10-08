/**
 * E2E v2.1 — perbaikan dari inspeksi serah terima produksi 8 Okt 2026:
 * (1) QR label `SID:PKG:<no>` diterima /scan; (2) checkpoint kurir & scan DELIVER sebelum pickup ditolak (order tidak macet);
 * (3) payment task mitra baru tanpa rekening: ON_HOLD → rekening terdaftar+terverifikasi → bisa diajukan; belum verifikasi → ditolak;
 * (4) pembatalan order membatalkan shipment & paket; (5) semua nilai uang rupiah penuh; (6) foto QC tidak tampil di katalog publik.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/app';
import { migrate, resetDatabase, pool } from '../../src/db';
import { seed } from '../../src/seed';
import { Api } from '../helpers';
import { normalizeScanCode } from '../../src/services/fulfillment';

process.env.UPLOAD_DIR = '/tmp/supplier-id-test-uploads-v2fix';
process.env.JOB_SECRET = 'job-secret-test';
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/supplier_id_test';
process.env.DATABASE_URL = TEST_DB;

const app = createApp();
const owner = new Api(app), maker = new Api(app), checker = new Api(app), ops = new Api(app), kurir = new Api(app), resto = new Api(app);
const mitraBaru = new Api(app);
let categories: any[] = []; let declaration: any; let courierUser: any;
const cat = (code: string) => categories.find((c) => c.code === code);
const SAYUR = { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Merah', harvest_date: '2026-10-08', defect_tolerance_pct: 5 };

beforeAll(async () => {
  await resetDatabase(TEST_DB); await migrate(TEST_DB); await seed();
  await Promise.all([owner.login('admin@supplier.id'), maker.login('maker@supplier.id'), checker.login('finance@supplier.id'), ops.login('ops@supplier.id'), kurir.login('kurir@supplier.id'), resto.login('buyer@supplier.id')]);
  categories = await owner.get('/api/categories'); declaration = await owner.get('/api/declaration');
  courierUser = (await owner.get('/api/admin/users')).find((u: any) => u.email === 'kurir@supplier.id');
  // mitra baru mendaftar sendiri — tanpa rekening bank (skenario nyata: order pertama datang sebelum rekening diisi)
  mitraBaru.token = (await mitraBaru.post('/api/auth/register', { email: 'uji-mitra-baru@supplier.id', password: 'MitraBaru#1', name: 'Mitra Baru', role: 'SUPPLIER', orgName: 'UJI Tani Baru', supplierKind: 'KELOMPOK_TANI', taxStatus: 'NON_PKP', region: 'Pekanbaru, Riau', phone: '0812000001' }, 201)).token;
});
afterAll(async () => { await pool.end(); });

async function publish(s: Api, o: { name: string; qty: number; price: number }) {
  const p = await s.post('/api/supplier/products', { category_id: cat('SAYUR').id, name: o.name, commodity: o.name, unit: 'KG', origin: 'Riau' });
  const b = await s.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: 'A', quantity: o.qty, unit: 'KG', expected_weight_kg: o.qty, harvest_date: '2026-10-08', availability_date: '2026-10-08', condition: 'Segar', size: 'Sedang', color: 'Merah', freshness: 'Baru panen (<24 jam)', attributes: SAYUR, price_per_unit: o.price });
  for (const kind of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await s.upload({ owner_type: 'BATCH', kind, batch_id: b.id, taken_at: new Date().toISOString() });
  return s.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version });
}
/** checkout 1 item → bayar → accept → picking → QC → packing (qty paket = qty order) → assign kurir. */
async function toScheduled(s: Api, batchId: string, qty: number) {
  const co = await resto.post('/api/checkout', { items: [{ batch_id: batchId, quantity: qty }], delivery_address: 'Resto Uji', distance_km: 4, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
  await resto.post(`/api/order-groups/${co.group.id}/pay`);
  const orderId = co.orders[0].id;
  const acc = (await s.get('/api/tasks?status=AWAITING_RESPONSE')).tasks.find((t: any) => t.order_id === orderId);
  const a = await s.post(`/api/tasks/${acc.id}/accept`, {});
  const done = await s.post(`/api/tasks/${a.next.id}/complete`, { result: { note: 'ok' } });
  await s.upload({ owner_type: 'QC', kind: 'QC_PHOTO', order_id: orderId, taken_at: new Date().toISOString() });
  const q = await s.post(`/api/tasks/${done.next.id}/qc`, { passed: true, measured_weight_kg: qty, grade: 'A' });
  const pkg = await s.post(`/api/tasks/${q.next.id}/packages`, { quantity: qty, weight_kg: qty });
  await s.post(`/api/packages/${pkg.id}/print`, { template: 'A4' });
  await s.post(`/api/tasks/${q.next.id}/complete-packing`);
  const as = await ops.post(`/api/dispatch/orders/${orderId}/assign`, { courier_user_id: courierUser.id }, 201);
  return { order: co.orders[0], group: co.group, pkg, shipment: as.shipment };
}

describe('Scan label: QR payload, Code128 dan tautan publik semua diterima', () => {
  it('normalizeScanCode memetakan semua bentuk ke nomor paket', () => {
    expect(normalizeScanCode('SID:PKG:PKG-2026-000003')).toBe('PKG-2026-000003');
    expect(normalizeScanCode(' pkg-2026-000003 ')).toBe('PKG-2026-000003');
    expect(normalizeScanCode('https://antarkitaindonesia.com/supplier-id/p/PKG-2026-000003')).toBe('PKG-2026-000003');
    expect(normalizeScanCode('ABC')).toBe('ABC');
  });
  it('kurir memindai payload QR → OK; checkpoint & DELIVER sebelum pickup ditolak; alur normal tetap jalan', async () => {
    const b = await publish(mitraBaru, { name: 'Cabai Merah', qty: 100, price: 45000 });
    const { order, pkg, shipment } = await toScheduled(mitraBaru, b.id, 10);
    // (2) checkpoint sebelum pickup → 409, paket tetap PACKED/HANDED_OVER
    await kurir.post(`/api/courier/shipments/${shipment.id}/events`, { location: 'prematur' }, 409);
    const d1 = await kurir.post('/api/scan', { code: `SID:PKG:${pkg.package_no}`, action: 'DELIVER', shipment_id: shipment.id }, 422);
    expect(d1.result).toBe('REJECTED'); expect(d1.reason).toMatch(/^ILLEGAL_(SHIPMENT_)?STATE_/);
    // (1) QR payload diterima
    const sc = await kurir.post('/api/scan', { code: `SID:PKG:${pkg.package_no}`, action: 'PICKUP', shipment_id: shipment.id });
    expect(sc.result).toBe('OK'); expect(sc.code).toBe(pkg.package_no);
    const pu = await kurir.post(`/api/courier/shipments/${shipment.id}/pickup`); expect(pu.status).toBe('PICKED_UP');
    await kurir.post(`/api/courier/shipments/${shipment.id}/events`, { location: 'Jl. Sudirman', temperature_c: 12 }, 201);
    const sd = await kurir.post('/api/scan', { code: `${pkg.package_no}`, action: 'DELIVER', shipment_id: shipment.id }); expect(sd.result).toBe('OK');
    const otp = (await resto.get(`/api/orders/${order.id}/delivery-otp`)).otp;
    const dv = await kurir.post(`/api/courier/shipments/${shipment.id}/deliver`, { otp, recipient_name: 'Chef Uji' });
    expect(dv.order.status).toBe('ARRIVED_WAITING_INSPECTION'); expect(dv.order.confirmation_due_at).toBeTruthy();
    // (5) rupiah penuh di semua komponen
    const o = await resto.get(`/api/orders/${order.id}`);
    for (const k of ['total_amount', 'payment_fee_amount', 'tax_amount', 'logistics_amount', 'platform_fee_amount']) expect(Number.isInteger(Number(o[k])), `${k}=${o[k]}`).toBe(true);
    // (6) foto QC order tidak bocor ke katalog publik
    const pub = await resto.get(`/api/listings/${b.id}`);
    expect(pub.photos.every((p: any) => p.owner_type !== 'QC')).toBe(true); expect(pub.photos.length).toBe(3);
    // (3) konfirmasi → payment task ON_HOLD (rekening belum ada) → release/submit ditolak sampai rekening terverifikasi
    await resto.post(`/api/orders/${order.id}/inspection`, { decision: 'ACCEPT' });
    const t = (await maker.get('/api/finance/payment-tasks')).tasks.find((x: any) => x.order_id === order.id);
    expect(t.status).toBe('ON_HOLD'); expect(t.bank_snapshot).toBeNull();
    await maker.post(`/api/finance/payment-tasks/${t.id}/submit`, {}, 409);
    const r1 = await owner.post(`/api/finance/payment-tasks/${t.id}/release`, {}, 409); expect(r1.error).toBe('BANK_ACCOUNT_MISSING');
    await mitraBaru.put('/api/supplier/bank-account', { bank_name: 'BRI', bank_account: '000111222333', bank_account_name: 'UJI Tani Baru' });
    const r2 = await owner.post(`/api/finance/payment-tasks/${t.id}/release`, {}, 409); expect(r2.error).toBe('BANK_ACCOUNT_UNVERIFIED');
    await owner.post(`/api/admin/organizations/${t.supplier_id}/verify-bank`);
    const rel = await owner.post(`/api/finance/payment-tasks/${t.id}/release`); expect(rel.status).toBe('CREATED');
    const sub = await maker.post(`/api/finance/payment-tasks/${t.id}/submit`); expect(sub.status).toBe('PENDING_APPROVAL');
    const det = await checker.get(`/api/finance/payment-tasks/${t.id}`); expect(det.bank_snapshot.account).toBe('000111222333'); expect(det.bank_snapshot.verified_at).toBeTruthy();
    await checker.post(`/api/finance/payment-tasks/${t.id}/approve`);
    const paid = await checker.post(`/api/finance/payment-tasks/${t.id}/mark-paid`, { bank_ref: 'BRI-TRF-UJI-1' }); expect(paid.status).toBe('PAID');
    expect((await owner.get('/api/admin/reconcile')).balanced).toBe(true);
  });
  it('(4) order dibatalkan admin setelah dispatch → shipment CANCELLED (hilang dari manifest kurir), paket CANCELLED, stok kembali, ledger seimbang', async () => {
    const b = await publish(mitraBaru, { name: 'Tomat', qty: 40, price: 12000 });
    const { order, shipment } = await toScheduled(mitraBaru, b.id, 5);
    expect((await kurir.get('/api/courier/shipments')).some((s: any) => s.id === shipment.id)).toBe(true);
    const c = await owner.post(`/api/orders/${order.id}/cancel`, { reason: 'uji batal setelah dispatch' }); expect(c.order?.status ?? c.status).toBe('CANCELLED');
    const sh = await kurir.get('/api/courier/shipments');
    expect(sh.find((s: any) => s.id === shipment.id)?.status).toBe('CANCELLED');
    const ready = await ops.get('/api/dispatch/ready'); expect(ready.active.some((s: any) => s.id === shipment.id)).toBe(false);
    const pk = await pool.query('SELECT status FROM packages WHERE order_id=$1', [order.id]); expect(pk.rows.every((r) => r.status === 'CANCELLED')).toBe(true);
    expect(Number((await resto.get(`/api/listings/${b.id}`)).available_quantity)).toBe(40);
    expect((await owner.get(`/api/orders/${order.id}/reconcile`)).balanced).toBe(true);
  });
});
