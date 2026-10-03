/**
 * E2E v2 — Supplier-ID: keranjang multi-mitra, reservasi atomik, task inbox mitra, QC berat aktual, paket/label/scan,
 * kurir + OTP, jendela konfirmasi 24 jam (auto-confirm & eskalasi), payment task maker/checker + idempotency + reversal,
 * webhook palsu/duplikat, RBAC lintas mitra, model dagang RESELLER, pembayaran kedaluwarsa.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { migrate, resetDatabase, pool } from '../../src/db';
import { seed } from '../../src/seed';
import { Api, sum } from '../helpers';
import crypto from 'node:crypto';

process.env.UPLOAD_DIR = '/tmp/supplier-id-test-uploads-v2';
process.env.JOB_SECRET = 'job-secret-test';
process.env.PAYMENT_WEBHOOK_SECRET = 'wh-secret-test';
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/supplier_id_test';
process.env.DATABASE_URL = TEST_DB;

const app = createApp();
const owner = new Api(app), maker = new Api(app), checker = new Api(app), ops = new Api(app), cs = new Api(app), kurir = new Api(app);
const tani = new Api(app), ternak = new Api(app), warga = new Api(app), resto = new Api(app);
let categories: any[] = []; let declaration: any;
const cat = (code: string) => categories.find((c) => c.code === code);

beforeAll(async () => {
  await resetDatabase(TEST_DB); await migrate(TEST_DB); await seed();
  await Promise.all([owner.login('admin@supplier.id'), maker.login('maker@supplier.id'), checker.login('finance@supplier.id'), ops.login('ops@supplier.id'), cs.login('cs@supplier.id'), kurir.login('kurir@supplier.id'),
    tani.login('tani@supplier.id'), ternak.login('ternak@supplier.id'), warga.login('warga@supplier.id'), resto.login('buyer@supplier.id')]);
  categories = await owner.get('/api/categories'); declaration = await owner.get('/api/declaration');
});
afterAll(async () => { await pool.end(); });

async function publish(s: Api, o: { code: string; name: string; qty: number; price: number; attributes: any; weight?: number }) {
  const p = await s.post('/api/supplier/products', { category_id: cat(o.code).id, name: o.name, commodity: o.name, unit: 'KG', origin: 'Riau' });
  const b = await s.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: 'A', quantity: o.qty, unit: 'KG', expected_weight_kg: o.weight ?? o.qty, harvest_date: '2026-10-03', availability_date: '2026-10-04', condition: 'Segar', size: 'Sedang', color: 'Hijau', freshness: 'Baru panen (<24 jam)', attributes: o.attributes, price_per_unit: o.price });
  for (const kind of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await s.upload({ owner_type: 'BATCH', kind, batch_id: b.id, taken_at: new Date().toISOString() });
  return s.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version });
}
const SAYUR = { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Hijau', harvest_date: '2026-10-03', defect_tolerance_pct: 5 };
const TELUR = { size: 'M (50-60g)', shell_condition: 'Utuh & bersih', grade: 'A', production_date: '2026-10-03' };
const jobs = () => request(app).post('/api/jobs/run').set('x-job-secret', 'job-secret-test').then((r) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; });

/** Jalankan alur mitra sampai READY_FOR_PICKUP; kembalikan paket. */
async function fulfill(s: Api, orderId: string, qc: any = {}) {
  const tasks = await s.get(`/api/tasks?status=AWAITING_RESPONSE`);
  const acc = tasks.tasks.find((t: any) => t.order_id === orderId);
  const a = await s.post(`/api/tasks/${acc.id}/accept`, { ready_at: new Date(Date.now() + 3600_000).toISOString() });
  expect(a.order.status).toBe('PROCESSING');
  const done = await s.post(`/api/tasks/${a.next.id}/complete`, { result: { note: 'picking selesai' } });
  expect(done.next.stage).toBe('QC');
  await s.upload({ owner_type: 'QC', kind: 'QC_PHOTO', order_id: orderId, taken_at: new Date().toISOString() });
  const q = await s.post(`/api/tasks/${done.next.id}/qc`, { passed: true, measured_temperature_c: 4, grade: 'A', ...qc });
  expect(q.next.stage).toBe('PACKING');
  return { packingTask: q.next, qc: q };
}
async function pack(s: Api, packingTaskId: string, qty: number) {
  const pkg = await s.post(`/api/tasks/${packingTaskId}/packages`, { quantity: qty, weight_kg: qty });
  await s.post(`/api/packages/${pkg.id}/print`, { template: 'A4' });
  const r = await s.post(`/api/tasks/${packingTaskId}/complete-packing`);
  expect(r.order.status).toBe('READY_FOR_PICKUP');
  return pkg;
}
let courierUser: any;

describe('Keranjang, checkout multi-mitra, reservasi atomik, pembayaran kedaluwarsa', () => {
  let bayam: any, telur: any;
  it('pelanggan perorangan mendaftar tanpa nama perusahaan; alamat tersimpan', async () => {
    const u = new Api(app);
    u.token = (await u.post('/api/auth/register', { email: 'ibu.ani@contoh.id', password: 'Ani12345!', name: 'Ibu Ani', role: 'BUYER', phone: '081234567' }, 201)).token;
    const me = await u.get('/api/auth/me'); expect(me.organization.buyer_kind).toBe('INDIVIDU'); expect(me.organization.name).toBe('Ibu Ani');
    const addr = await u.post('/api/me/addresses', { recipient: 'Ibu Ani', phone: '081234567', address: 'Jl. Melati 1', city: 'Pekanbaru', distance_km: 12 }, 201);
    expect(addr.is_default).toBe(true);
  });
  it('checkout 2 item dari 2 mitra → 1 order induk + 2 suborder PENDING_PAYMENT, stok direservasi, bayar → PAID + task ACCEPTANCE per mitra', async () => {
    bayam = await publish(tani, { code: 'SAYUR', name: 'Bayam', qty: 50, price: 10000, attributes: SAYUR });
    telur = await publish(ternak, { code: 'TELUR', name: 'Telur', qty: 100, price: 2000, attributes: TELUR });
    await warga.post('/api/cart/items', { batch_id: bayam.id, quantity: 10 }, 201);
    await warga.post('/api/cart/items', { batch_id: telur.id, quantity: 30 }, 201);
    const cart = await warga.get('/api/cart'); expect(cart.items.length).toBe(2); expect(cart.suppliers).toBe(2);
    await warga.post('/api/checkout', { delivery_address: 'Jl. A', distance_km: 10, accept_auto_confirm_policy: true }, 400); // toleransi berat wajib disetujui
    const addr = (await warga.post('/api/me/addresses', { recipient: 'Ibu Wati', phone: '081345678', address: 'Jl. Sudirman 5', city: 'Pekanbaru', distance_km: 8 }, 201));
    const co = await warga.post('/api/checkout', { address_id: addr.id, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    expect(co.orders.length).toBe(2); expect(co.orders.every((o: any) => o.status === 'PENDING_PAYMENT' && o.payment_due_at)).toBe(true);
    expect(co.group.total_amount).toBe(sum(co.orders.map((o: any) => o.total_amount)));
    expect((await warga.get('/api/cart')).items.length).toBe(0);
    const b1 = await owner.get(`/api/listings/${bayam.id}`); expect(Number(b1.available_quantity)).toBe(40);
    const pay = await warga.post(`/api/order-groups/${co.group.id}/pay`, { channel: 'VA' });
    expect(pay.is_sandbox).toBe(true); expect(pay.orders.every((o: any) => o.status === 'PAID')).toBe(true);
    const t1 = await tani.get('/api/tasks?status=AWAITING_RESPONSE'); expect(t1.tasks.some((t: any) => t.order_id === co.orders[0].id)).toBe(true);
    const t2 = await ternak.get('/api/tasks'); expect(t2.tasks.some((t: any) => t.stage === 'ACCEPTANCE' && t.order_id === co.orders[1].id)).toBe(true);
    // RBAC: mitra B tidak melihat task mitra A
    expect(t2.tasks.some((t: any) => t.order_id === co.orders[0].id)).toBe(false);
    await ternak.get(`/api/tasks/${t1.tasks[0].id}`, 403);
  });
  it('dua pembeli membeli stok terakhir secara bersamaan → tepat satu berhasil; stok tidak negatif', async () => {
    const last = await publish(tani, { code: 'SAYUR', name: 'Kangkung', qty: 5, price: 8000, attributes: SAYUR });
    const r = await Promise.all([
      request(app).post('/api/checkout').set('Authorization', `Bearer ${warga.token}`).send({ items: [{ batch_id: last.id, quantity: 5 }], delivery_address: 'A', accept_auto_confirm_policy: true, accept_weight_tolerance: true }),
      request(app).post('/api/checkout').set('Authorization', `Bearer ${resto.token}`).send({ items: [{ batch_id: last.id, quantity: 5 }], delivery_address: 'B', accept_auto_confirm_policy: true, accept_weight_tolerance: true }),
    ]);
    const statuses = r.map((x) => x.status).sort(); expect(statuses).toEqual([201, 409]);
    const b = await owner.get(`/api/listings/${last.id}`); expect(Number(b.available_quantity)).toBe(0); expect(b.status).toBe('SOLD_OUT');
  });
  it('pembayaran kedaluwarsa → job membatalkan order & melepas reservasi', async () => {
    const co = await resto.post('/api/checkout', { items: [{ batch_id: telur.id, quantity: 20 }], delivery_address: 'Resto', distance_km: 5, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await pool.query(`UPDATE orders SET payment_due_at=now() - interval '1 minute' WHERE id=$1`, [co.orders[0].id]);
    const jr = await jobs(); expect(jr.expired_payments).toBeGreaterThanOrEqual(1);
    const o = await resto.get(`/api/orders/${co.orders[0].id}`); expect(o.status).toBe('CANCELLED');
    expect(Number((await owner.get(`/api/listings/${telur.id}`)).available_quantity)).toBe(70);
    await resto.post(`/api/order-groups/${co.group.id}/pay`, {}, 409);
  });
});

describe('Task inbox mitra, QC berat aktual, paket/label/scan, kurir + OTP, konfirmasi 24 jam, payment task', () => {
  let order: any, packingTask: any, pkg: any, shipment: any, otp: string, paymentTask: any;
  it('mitra menolak → eskalasi ops, alokasi tidak digandakan; ops membatalkan → refund', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Sawi', qty: 20, price: 9000, attributes: SAYUR });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 5 }], delivery_address: 'A', distance_km: 3, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const t = (await tani.get('/api/tasks?status=AWAITING_RESPONSE')).tasks.find((x: any) => x.order_id === co.orders[0].id);
    await tani.post(`/api/tasks/${t.id}/reject`, { reason: 'x' }, 400);
    const rj = await tani.post(`/api/tasks/${t.id}/reject`, { reason: 'Stok rusak karena hujan' });
    expect(rj.escalation.kind).toBe('SUPPLIER_REJECTED');
    await tani.post(`/api/tasks/${t.id}/accept`, {}, 409); // tidak bisa diterima lagi
    const esc = await ops.get('/api/admin/escalations'); expect(esc.some((e: any) => e.order_id === co.orders[0].id)).toBe(true);
    const c = await ops.post(`/api/orders/${co.orders[0].id}/cancel`, { reason: 'Mitra menolak; refund' }); expect(c.status).toBe('CANCELLED');
    expect((await owner.get(`/api/orders/${co.orders[0].id}/reconcile`)).balanced).toBe(true);
  });
  it('mitra menerima → PROCESSING → picking → QC lulus (berat dalam toleransi) → packing: paket + label wajib → READY_FOR_PICKUP', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Bayam Merah', qty: 100, price: 12000, attributes: SAYUR, weight: 100 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 10 }], delivery_address: 'Jl. Sudirman 5', distance_km: 8, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    order = co.orders[0];
    const f = await fulfill(tani, order.id, { measured_weight_kg: 10.1 });
    expect(f.qc.weight_adjustment.status).toBe('WITHIN_TOLERANCE');
    packingTask = f.packingTask;
    await tani.post(`/api/tasks/${packingTask.id}/complete-packing`, {}, 409); // belum ada paket
    await tani.post(`/api/tasks/${packingTask.id}/packages`, { quantity: 11 }, 400); // melebihi order
    pkg = await tani.post(`/api/tasks/${packingTask.id}/packages`, { quantity: 10, weight_kg: 10.1 }, 201);
    expect(pkg.package_no).toMatch(/^PKG-/);
    await tani.post(`/api/tasks/${packingTask.id}/complete-packing`, {}, 409); // label belum dicetak
    const label = await tani.get(`/api/packages/${pkg.id}/label`); expect(label.qr_payload).toBe(`SID:PKG:${pkg.package_no}`); expect(label.code128).toBe(pkg.package_no);
    await tani.post(`/api/packages/${pkg.id}/print`, { template: 'A4' });
    await tani.post(`/api/packages/${pkg.id}/print`, { template: 'A4' }, 400); // reprint tanpa alasan
    const rp = await tani.post(`/api/packages/${pkg.id}/print`, { template: 'A4', reason: 'Label sobek' }); expect(rp.version).toBe(2); expect(rp.reprint).toBe(true);
    const r = await tani.post(`/api/tasks/${packingTask.id}/complete-packing`); expect(r.order.status).toBe('READY_FOR_PICKUP'); expect(r.next.stage).toBe('HANDOVER');
    await ternak.get(`/api/packages/${pkg.id}/label`, 403); // isolasi mitra
  });
  it('dispatcher menugaskan kurir (OTP ke pelanggan); scan: kode asing/duplikat/peran salah ditolak; pickup hanya setelah semua paket dipindai', async () => {
    const d = await ops.get('/api/dispatch/ready'); expect(d.ready.some((o: any) => o.id === order.id)).toBe(true);
    courierUser = d.couriers.find((c: any) => c.name === 'Kurir Andi');
    const as = await ops.post(`/api/dispatch/orders/${order.id}/assign`, { courier_user_id: courierUser.id, cold_chain: true }, 201);
    shipment = as.shipment;
    const manifest = await kurir.get('/api/courier/shipments'); expect(manifest.some((s: any) => s.id === shipment.id)).toBe(true);
    await kurir.post(`/api/courier/shipments/${shipment.id}/pickup`, {}, 409); // belum scan
    expect((await kurir.post('/api/scan', { code: 'PKG-9999-999999', action: 'PICKUP' }, 422)).reason).toBe('UNKNOWN_CODE');
    expect((await warga.post('/api/scan', { code: pkg.package_no, action: 'PICKUP' }, 422)).reason).toBe('ROLE_NOT_ALLOWED');
    const h = await tani.post('/api/scan', { code: pkg.package_no, action: 'HANDOVER' }); expect(h.result).toBe('OK');
    const s1 = await kurir.post('/api/scan', { code: pkg.package_no, action: 'PICKUP', shipment_id: shipment.id }); expect(s1.result).toBe('OK');
    expect((await kurir.post('/api/scan', { code: pkg.package_no, action: 'PICKUP', shipment_id: shipment.id }, 422)).reason).toBe('DUPLICATE_SCAN');
    const pu = await kurir.post(`/api/courier/shipments/${shipment.id}/pickup`); expect(pu.status).toBe('PICKED_UP');
    await kurir.post(`/api/courier/shipments/${shipment.id}/events`, { location: 'Jl. Riau', temperature_c: 5 }, 201);
    const ht = (await tani.get('/api/tasks?stage=HANDOVER')).tasks.find((t: any) => t.order_id === order.id); expect(ht.status).toBe('DONE');
  });
  it('serah terima: OTP salah ditolak; OTP benar → ARRIVED + delivered_at + confirmation_due_at (+24 jam server)', async () => {
    const o = await warga.get(`/api/orders/${order.id}/delivery-otp`); otp = o.otp; expect(otp).toMatch(/^\d{6}$/);
    expect((await kurir.post('/api/scan', { code: pkg.package_no, action: 'DELIVER', shipment_id: shipment.id })).result).toBe('OK');
    await kurir.post(`/api/courier/shipments/${shipment.id}/deliver`, { otp: '000000', recipient_name: 'Wati' }, 400);
    const d = await kurir.post(`/api/courier/shipments/${shipment.id}/deliver`, { otp, recipient_name: 'Ibu Wati' });
    expect(d.order.status).toBe('ARRIVED_WAITING_INSPECTION'); expect(d.order.delivery_evidence_valid).toBe(true);
    const due = new Date(d.order.confirmation_due_at).getTime() - new Date(d.order.delivered_at).getTime();
    expect(Math.round(due / 3600_000)).toBe(24);
  });
  it('pelanggan konfirmasi sesuai sebelum tenggat → SETTLED + TEPAT SATU payment task (konfirmasi ganda tidak menggandakan)', async () => {
    const r = await warga.post(`/api/orders/${order.id}/inspection`, { decision: 'ACCEPT' });
    expect(r.order.status).toBe('SETTLED'); expect(r.order.confirmed_by).toBe('BUYER');
    await warga.post(`/api/orders/${order.id}/inspection`, { decision: 'ACCEPT' }, 409);
    const pts = await maker.get('/api/finance/payment-tasks'); const mine = pts.tasks.filter((t: any) => t.order_id === order.id);
    expect(mine.length).toBe(1); paymentTask = mine[0];
    expect(paymentTask.status).toBe('CREATED'); expect(paymentTask.trigger).toBe('BUYER_CONFIRM'); expect(Number(paymentTask.net_amount)).toBe(Number(order.product_value));
    const sp = await tani.get('/api/supplier/payment-tasks'); expect(sp.tasks.some((t: any) => t.id === paymentTask.id)).toBe(true);
  });
  it('maker/checker: checker tidak boleh = maker; CS tidak boleh menyetujui; provider NONE gagal jelas; MOCK → PROCESSING → inquiry → PAID → ledger; proses ganda tidak menggandakan; reversal', async () => {
    await checker.post(`/api/finance/payment-tasks/${paymentTask.id}/submit`, {}, 403); // checker tidak punya payouts.make
    await maker.post(`/api/finance/payment-tasks/${paymentTask.id}/submit`);
    await maker.post(`/api/finance/payment-tasks/${paymentTask.id}/approve`, {}, 403);
    await cs.post(`/api/finance/payment-tasks/${paymentTask.id}/approve`, {}, 403);
    const ap = await checker.post(`/api/finance/payment-tasks/${paymentTask.id}/approve`); expect(ap.status).toBe('APPROVED'); expect(ap.due_at).toBeTruthy();
    const e1 = await maker.post(`/api/finance/payment-tasks/${paymentTask.id}/process`, {}, 409); expect(e1.error).toBe('PAYOUT_PROVIDER_NOT_CONFIGURED');
    await owner.put('/api/admin/settings/payout.provider', { value: 'MOCK', reason: 'uji sandbox' });
    const pr = await maker.post(`/api/finance/payment-tasks/${paymentTask.id}/process`); expect(pr.task.status).toBe('PROCESSING'); expect(pr.payout.is_sandbox).toBe(true);
    const dup = await maker.post(`/api/finance/payment-tasks/${paymentTask.id}/process`, {}, 409); expect(dup.error).toBe('TASK_NOT_APPROVED');
    const inq = await checker.post(`/api/finance/payment-tasks/${paymentTask.id}/inquiry`); expect(inq.status).toBe('PAID');
    const det = await checker.get(`/api/finance/payment-tasks/${paymentTask.id}`);
    expect(det.ledger.some((l: any) => l.component === 'SUPPLIER_PAYOUT')).toBe(true); expect(det.ledger_net.net).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM payouts WHERE idempotency_key=$1', [paymentTask.settlement_key])).rows[0].n).toBe(1);
    const rv = await checker.post(`/api/finance/payment-tasks/${paymentTask.id}/reverse`, { reason: 'Bank mengembalikan dana (rekening salah)' }); expect(rv.status).toBe('REVERSED');
    const net = (await checker.get(`/api/finance/payment-tasks/${paymentTask.id}`)).ledger_net; expect(net.net).toBe(Number(order.product_value));
    expect((await owner.get('/api/admin/reconcile')).balanced).toBe(true);
  });
  it('transfer manual (provider NONE): checker mencatat bukti bank → PAID; maker tidak boleh', async () => {
    await owner.put('/api/admin/settings/payout.provider', { value: 'NONE', reason: 'kembali manual' });
    const b = await publish(ternak, { code: 'TELUR', name: 'Telur Omega', qty: 50, price: 2500, attributes: TELUR, weight: 3 });
    const co = await resto.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 10 }], delivery_address: 'Resto', distance_km: 4, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await resto.post(`/api/order-groups/${co.group.id}/pay`);
    const f = await fulfill(ternak, co.orders[0].id); await pack(ternak, f.packingTask.id, 10);
    const as = await ops.post(`/api/dispatch/orders/${co.orders[0].id}/assign`, { courier_user_id: courierUser.id }, 201);
    const pk = (await kurir.get(`/api/courier/shipments/${as.shipment.id}`)).packages[0];
    await kurir.post('/api/scan', { code: pk.package_no, action: 'PICKUP', shipment_id: as.shipment.id });
    await kurir.post(`/api/courier/shipments/${as.shipment.id}/pickup`);
    await kurir.post('/api/scan', { code: pk.package_no, action: 'DELIVER', shipment_id: as.shipment.id });
    const otp2 = (await resto.get(`/api/orders/${co.orders[0].id}/delivery-otp`)).otp;
    await kurir.post(`/api/courier/shipments/${as.shipment.id}/deliver`, { otp: otp2, recipient_name: 'Rina' });
    await resto.post(`/api/orders/${co.orders[0].id}/inspection`, { decision: 'ACCEPT' });
    const t = (await maker.get('/api/finance/payment-tasks')).tasks.find((x: any) => x.order_id === co.orders[0].id);
    await maker.post(`/api/finance/payment-tasks/${t.id}/submit`); await checker.post(`/api/finance/payment-tasks/${t.id}/approve`);
    await maker.post(`/api/finance/payment-tasks/${t.id}/mark-paid`, { bank_ref: 'BRI-123' }, 403);
    const paid = await checker.post(`/api/finance/payment-tasks/${t.id}/mark-paid`, { bank_ref: 'BRI-TRF-20261004-001' }); expect(paid.status).toBe('PAID');
  });
});

describe('Jendela 24 jam: auto-confirm sesuai policy; tanpa bukti valid → eskalasi; sengketa menahan payment task', () => {
  it('auto-confirm setelah tenggat (OTP valid, PAID, tanpa sengketa) → SETTLED + payment task AUTO_CONFIRM', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Selada', qty: 40, price: 15000, attributes: SAYUR, weight: 40 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 4 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const f = await fulfill(tani, co.orders[0].id); await pack(tani, f.packingTask.id, 4);
    const as = await ops.post(`/api/dispatch/orders/${co.orders[0].id}/assign`, { courier_user_id: courierUser.id }, 201);
    const pk = (await kurir.get(`/api/courier/shipments/${as.shipment.id}`)).packages[0];
    await kurir.post('/api/scan', { code: pk.package_no, action: 'PICKUP', shipment_id: as.shipment.id }); await kurir.post(`/api/courier/shipments/${as.shipment.id}/pickup`);
    await kurir.post('/api/scan', { code: pk.package_no, action: 'DELIVER', shipment_id: as.shipment.id });
    const otp = (await warga.get(`/api/orders/${co.orders[0].id}/delivery-otp`)).otp;
    await kurir.post(`/api/courier/shipments/${as.shipment.id}/deliver`, { otp, recipient_name: 'Wati' });
    let jr = await jobs(); // belum jatuh tempo
    let o = await warga.get(`/api/orders/${co.orders[0].id}`); expect(o.status).toBe('ARRIVED_WAITING_INSPECTION');
    await pool.query(`UPDATE orders SET confirmation_due_at=now() - interval '1 minute' WHERE id=$1`, [co.orders[0].id]);
    jr = await jobs(); expect(jr.confirmations.auto).toBeGreaterThanOrEqual(1);
    o = await warga.get(`/api/orders/${co.orders[0].id}`); expect(o.status).toBe('SETTLED'); expect(o.confirmed_by).toBe('AUTO');
    const t = (await maker.get('/api/finance/payment-tasks')).tasks.filter((x: any) => x.order_id === co.orders[0].id); expect(t.length).toBe(1); expect(t[0].trigger).toBe('AUTO_CONFIRM');
    expect((await jobs()).confirmations.auto).toBe(0); // idempotent
  });
  it('serah terima dengan foto (tanpa OTP) → bukti belum valid → lewat tenggat TIDAK auto-confirm, masuk eskalasi; ops verifikasi → jendela dimulai; ops-confirm → payment task OPS_CONFIRM', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Pakcoy', qty: 40, price: 11000, attributes: SAYUR, weight: 40 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 4 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const f = await fulfill(tani, co.orders[0].id); await pack(tani, f.packingTask.id, 4);
    const as = await ops.post(`/api/dispatch/orders/${co.orders[0].id}/assign`, { courier_user_id: courierUser.id }, 201);
    const pk = (await kurir.get(`/api/courier/shipments/${as.shipment.id}`)).packages[0];
    await kurir.post('/api/scan', { code: pk.package_no, action: 'PICKUP', shipment_id: as.shipment.id }); await kurir.post(`/api/courier/shipments/${as.shipment.id}/pickup`);
    await kurir.post('/api/scan', { code: pk.package_no, action: 'DELIVER', shipment_id: as.shipment.id });
    await kurir.post(`/api/courier/shipments/${as.shipment.id}/deliver`, { recipient_name: 'Satpam' }, 400); // tanpa OTP & tanpa foto
    await kurir.upload({ owner_type: 'DELIVERY', kind: 'DELIVERY_PROOF', shipment_id: as.shipment.id, taken_at: new Date().toISOString() });
    const d = await kurir.post(`/api/courier/shipments/${as.shipment.id}/deliver`, { recipient_name: 'Satpam' });
    expect(d.order.delivery_evidence_valid).toBe(false); expect(d.order.confirmation_due_at).toBeNull();
    await pool.query(`UPDATE orders SET confirmation_due_at=now() - interval '1 minute', needs_ops_review=FALSE WHERE id=$1`, [co.orders[0].id]);
    const jr = await jobs(); expect(jr.confirmations.escalated).toBeGreaterThanOrEqual(1);
    let o = await warga.get(`/api/orders/${co.orders[0].id}`); expect(o.status).toBe('ARRIVED_WAITING_INSPECTION');
    expect((await maker.get('/api/finance/payment-tasks')).tasks.some((x: any) => x.order_id === co.orders[0].id)).toBe(false);
    const v = await ops.post(`/api/admin/shipments/${as.shipment.id}/verify-evidence`, { valid: true, note: 'Foto jelas, satpam resto' }); expect(v.delivery_evidence_valid).toBe(true); expect(v.confirmation_due_at).toBeTruthy();
    const oc = await ops.post(`/api/admin/orders/${co.orders[0].id}/ops-confirm`, { note: 'Pelanggan konfirmasi via telepon' }); expect(oc.order.status).toBe('SETTLED'); expect(oc.payment_task.trigger).toBe('OPS_CONFIRM');
  });
  it('komplain sebelum tenggat (partial accept) → return case menahan; payment task baru dibuat setelah retur selesai dengan neto setelah potongan', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Kol', qty: 40, price: 10000, attributes: SAYUR, weight: 40 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 10 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const f = await fulfill(tani, co.orders[0].id); await pack(tani, f.packingTask.id, 10);
    const as = await ops.post(`/api/dispatch/orders/${co.orders[0].id}/assign`, { courier_user_id: courierUser.id }, 201);
    const pk = (await kurir.get(`/api/courier/shipments/${as.shipment.id}`)).packages[0];
    await kurir.post('/api/scan', { code: pk.package_no, action: 'PICKUP', shipment_id: as.shipment.id }); await kurir.post(`/api/courier/shipments/${as.shipment.id}/pickup`);
    await kurir.post('/api/scan', { code: pk.package_no, action: 'DELIVER', shipment_id: as.shipment.id });
    const otp = (await warga.get(`/api/orders/${co.orders[0].id}/delivery-otp`)).otp;
    await kurir.post(`/api/courier/shipments/${as.shipment.id}/deliver`, { otp, recipient_name: 'Wati' });
    await warga.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: co.orders[0].id }); await warga.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_VIDEO', order_id: co.orders[0].id }, true);
    const ins = await warga.post(`/api/orders/${co.orders[0].id}/inspection`, { decision: 'PARTIAL_ACCEPT', accepted_quantity: 8, reason_code: 'NOT_FRESH', description: '2 kg layu' });
    expect(ins.return_case.status).toBe('EVIDENCE_REVIEW');
    expect((await maker.get('/api/finance/payment-tasks')).tasks.some((x: any) => x.order_id === co.orders[0].id)).toBe(false);
    await pool.query(`UPDATE orders SET confirmation_due_at=now() - interval '1 minute' WHERE id=$1`, [co.orders[0].id]);
    await jobs(); // tidak menyentuh order yang sudah diinspeksi
    const dec = await cs.post(`/api/returns/${ins.return_case.id}/decide`, { decision: 'APPROVED', fault_attribution: 'SUPPLIER', notes: 'Bukti jelas' });
    expect(Number(dec.adjustment.adjustment.supplier_deduction)).toBeGreaterThan(0);
    await ops.post(`/api/returns/${ins.return_case.id}/pickup`, { carrier: 'Kurir' });
    const rcv = await tani.post(`/api/returns/${ins.return_case.id}/receive`, { notes: 'diterima' }); expect(rcv.status).toBe('CLOSED');
    const t = (await maker.get('/api/finance/payment-tasks')).tasks.filter((x: any) => x.order_id === co.orders[0].id);
    expect(t.length).toBe(1); expect(t[0].trigger).toBe('DISPUTE_RESOLVED'); expect(Number(t[0].net_amount)).toBeLessThan(Number(co.orders[0].product_value)); expect(Number(t[0].net_amount)).toBeGreaterThan(0);
    expect((await owner.get('/api/admin/reconcile')).balanced).toBe(true);
  });
});

describe('Berat aktual, model RESELLER, webhook, tiket CS, gagal antar', () => {
  it('QC berat kurang di luar toleransi → refund selisih otomatis (mitra menanggung); berat lebih → PENDING_CUSTOMER → pelanggan menolak → kemas ulang', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Wortel', qty: 100, price: 10000, attributes: SAYUR, weight: 100 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 10 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const f = await fulfill(tani, co.orders[0].id, { measured_weight_kg: 9 });
    expect(f.qc.weight_adjustment.status).toBe('SHORTAGE_REFUND'); expect(f.qc.weight_adjustment.delta_value).toBe(-10000);
    const o = await warga.get(`/api/orders/${co.orders[0].id}`);
    expect(o.adjustments.some((a: any) => a.adjustment_type === 'WEIGHT_SHORTAGE' && Number(a.refund_to_buyer) === 10000)).toBe(true);
    expect((await owner.get(`/api/orders/${co.orders[0].id}/reconcile`)).balanced).toBe(true);
    // kelebihan berat
    const co2 = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 10 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co2.group.id}/pay`);
    const f2 = await fulfill(tani, co2.orders[0].id, { measured_weight_kg: 11 });
    expect(f2.qc.weight_adjustment.status).toBe('PENDING_CUSTOMER'); expect(f2.packingTask.status).toBe('NEEDS_ACTION');
    await tani.post(`/api/tasks/${f2.packingTask.id}/packages`, { quantity: 10 }, 409); // menunggu pelanggan
    const dcl = await warga.post(`/api/orders/${co2.orders[0].id}/weight-decision`, { decision: 'DECLINE' }); expect(dcl.decision).toBe('DECLINE');
    const t = await tani.get(`/api/tasks/${f2.packingTask.id}`); expect(t.status).toBe('IN_PROGRESS'); expect(t.instructions).toMatch(/Kemas ulang/);
    // pelanggan menyetujui pada order lain → pembayaran tambahan tercatat (bukan diam-diam)
    const co3 = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 10 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co3.group.id}/pay`);
    await fulfill(tani, co3.orders[0].id, { measured_weight_kg: 11 });
    const ap = await warga.post(`/api/orders/${co3.orders[0].id}/weight-decision`, { decision: 'APPROVE' }); expect(ap.payment.channel).toBe('ADDITIONAL'); expect(Number(ap.payment.amount)).toBe(10000);
    expect((await owner.get(`/api/orders/${co3.orders[0].id}/reconcile`)).balanced).toBe(true);
  });
  it('kategori RESELLER: harga jual = harga mitra × 1,2; fee platform 0; ledger: hak mitra = harga beli, margin = pendapatan Supplier-ID; pembatalan & retur membalik proporsional', async () => {
    const daging = cat('DAGING');
    await owner.put(`/api/admin/categories/${daging.code}`, { name: daging.name, attribute_schema: daging.attribute_schema, tax_class: daging.tax_class, trade_model: 'RESELLER', reseller_markup_pct: 20, reason: 'Keputusan hibrida' });
    const b = await publish(ternak, { code: 'DAGING', name: 'Daging Sapi', qty: 50, price: 100000, attributes: { cut: 'Topside', weight_per_pack_kg: 1, storage_temperature_c: 2, slaughter_date: '2026-10-03', state: 'Chilled' }, weight: 50 });
    const list = await warga.get(`/api/listings/${b.id}`); expect(Number(list.price_per_unit)).toBe(120000); expect(list.trade_model).toBe('RESELLER');
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 2 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    const o = co.orders[0];
    expect(Number(o.unit_price)).toBe(120000); expect(Number(o.product_value)).toBe(240000); expect(Number(o.purchase_value)).toBe(200000); expect(Number(o.platform_fee_amount)).toBe(0); expect(o.trade_model).toBe('RESELLER');
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const d = await owner.get(`/api/orders/${o.id}`);
    const payable = d.ledger.filter((l: any) => l.account === 'SUPPLIER_PAYABLE' && l.side === 'CREDIT').reduce((s: number, l: any) => s + Number(l.amount), 0);
    const margin = d.ledger.filter((l: any) => l.account === 'RESELLER_MARGIN_REVENUE' && l.side === 'CREDIT').reduce((s: number, l: any) => s + Number(l.amount), 0);
    expect(payable).toBe(200000); expect(margin).toBe(40000);
    const c = await warga.post(`/api/orders/${o.id}/cancel`, { reason: 'Batal' }); expect(c.status).toBe('CANCELLED');
    expect((await owner.get(`/api/orders/${o.id}/reconcile`)).balanced).toBe(true);
    const mon = await owner.get('/api/admin/monetization'); expect(mon.reconciliation.balanced).toBe(true);
  });
  it('webhook pembayaran: tanda tangan palsu ditolak; duplikat diabaikan; status PAID tidak diubah oleh event terlambat', async () => {
    const body = { event_id: 'evt-1', type: 'payment.paid', provider_ref: 'MOCK-none' };
    const raw = JSON.stringify(body);
    await request(app).post('/api/webhooks/payment').set('Content-Type', 'application/json').set('x-signature', 'deadbeef').send(raw).expect(401);
    const sig = crypto.createHmac('sha256', 'wh-secret-test').update(raw).digest('hex');
    const r1 = await request(app).post('/api/webhooks/payment').set('Content-Type', 'application/json').set('x-signature', sig).send(raw).expect(200);
    expect(r1.body.result).toBe('IGNORED_UNKNOWN_REF');
    const r2 = await request(app).post('/api/webhooks/payment').set('Content-Type', 'application/json').set('x-signature', sig).send(raw).expect(200);
    expect(r2.body.duplicate).toBe(true);
    const paid = (await pool.query(`SELECT provider_ref FROM payments WHERE status='PAID' LIMIT 1`)).rows[0];
    const body2 = { event_id: 'evt-2', type: 'payment.paid', provider_ref: paid.provider_ref }; const raw2 = JSON.stringify(body2);
    const r3 = await request(app).post('/api/webhooks/payment').set('Content-Type', 'application/json').set('x-signature', crypto.createHmac('sha256', 'wh-secret-test').update(raw2).digest('hex')).send(raw2).expect(200);
    expect(r3.body.result).toBe('IGNORED_STATUS_PAID');
  });
  it('tiket CS terhubung order menahan payment task sampai ditutup; mitra lain tidak bisa membaca tiket', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Tomat', qty: 40, price: 9000, attributes: SAYUR, weight: 40 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 4 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const tk = await warga.post('/api/tickets', { order_id: co.orders[0].id, category: 'COMPLAINT', subject: 'Kurir belum datang', body: 'Sudah 2 hari' }, 201);
    await ternak.get(`/api/tickets/${tk.id}`, 403);
    await kurir.get('/api/tickets', 403);
    const list = await cs.get('/api/tickets'); expect(list.some((t: any) => t.id === tk.id)).toBe(true);
    await cs.post(`/api/tickets/${tk.id}/messages`, { body: 'Kami cek ke kurir', internal: false }, 201);
    await maker.patch(`/api/tickets/${tk.id}`, { status: 'RESOLVED' }, 403);
    const o = await warga.get(`/api/orders/${co.orders[0].id}`); expect(o.hold_reason).toMatch(/Tiket/);
    await cs.patch(`/api/tickets/${tk.id}`, { status: 'RESOLVED', resolution: 'Kurir dikirim ulang' });
    expect((await warga.get(`/api/orders/${co.orders[0].id}`)).hold_reason).toBeNull();
  });
  it('gagal antar 2× → eskalasi; kirim ulang; dashboard ops & laporan scan tersedia; auditor hanya baca', async () => {
    const b = await publish(tani, { code: 'SAYUR', name: 'Cabai', qty: 40, price: 30000, attributes: SAYUR, weight: 40 });
    const co = await warga.post('/api/checkout', { items: [{ batch_id: b.id, quantity: 2 }], delivery_address: 'A', distance_km: 2, accept_auto_confirm_policy: true, accept_weight_tolerance: true }, 201);
    await warga.post(`/api/order-groups/${co.group.id}/pay`);
    const f = await fulfill(tani, co.orders[0].id); await pack(tani, f.packingTask.id, 2);
    const as = await ops.post(`/api/dispatch/orders/${co.orders[0].id}/assign`, { courier_user_id: courierUser.id }, 201);
    const pk = (await kurir.get(`/api/courier/shipments/${as.shipment.id}`)).packages[0];
    await kurir.post('/api/scan', { code: pk.package_no, action: 'PICKUP', shipment_id: as.shipment.id }); await kurir.post(`/api/courier/shipments/${as.shipment.id}/pickup`);
    const f1 = await kurir.post(`/api/courier/shipments/${as.shipment.id}/fail`, { reason: 'Alamat tidak ditemukan' }); expect(f1.escalated).toBe(false);
    await kurir.post(`/api/courier/shipments/${as.shipment.id}/redeliver`);
    const f2 = await kurir.post(`/api/courier/shipments/${as.shipment.id}/fail`, { reason: 'Penerima tidak ada' }); expect(f2.escalated).toBe(true);
    const dash = await ops.get('/api/admin/ops-dashboard'); expect(dash.delivery.failed).toBeGreaterThanOrEqual(1); expect(dash.reconciliation.balanced).toBe(true);
    const scans = await ops.get('/api/scans?result=REJECTED'); expect(scans.length).toBeGreaterThan(0);
    const auditor = new Api(app);
    const a = await owner.post('/api/admin/users', { email: 'audit@supplier.id', name: 'Auditor', password: 'Audit12345', role: 'ADMIN', admin_role: 'AUDITOR' }, 201);
    expect(a.admin_role).toBe('AUDITOR');
    await auditor.login('audit@supplier.id', 'Audit12345');
    await auditor.get('/api/admin/ops-dashboard'); await auditor.get('/api/scans');
    await auditor.post(`/api/admin/escalations/${(await ops.get('/api/admin/escalations'))[0].id}/resolve`, { resolution: 'x' }, 403);
    await owner.get('/api/jobs/runs');
  });
});
