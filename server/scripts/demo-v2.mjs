#!/usr/bin/env node
/**
 * Data demo v2 (lokal, server berjalan): keranjang → checkout → bayar → task mitra → QC → packing/label → dispatch → kurir → OTP → konfirmasi → payment task.
 * Meninggalkan order pada berbagai tahap agar UI tiap peran punya data. Jalankan: node scripts/demo-v2.mjs [http://localhost:4000]
 */
const BASE = process.argv[2] || 'http://localhost:4000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
class Api {
  constructor() { this.token = ''; }
  async login(email) { const r = await this.req('POST', '/api/auth/login', { email, password: 'Password123' }); this.token = r.token; return r; }
  async req(method, path, body, expectFail = false) {
    const headers = { Authorization: `Bearer ${this.token}` }; let payload;
    if (body instanceof FormData) payload = body; else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + path, { method, headers, body: payload }); const j = await r.json().catch(() => null);
    if (!r.ok && !expectFail) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
  get(p) { return this.req('GET', p); } post(p, b) { return this.req('POST', p, b ?? {}); } put(p, b) { return this.req('PUT', p, b); }
  async upload(meta) { const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'foto.png'); for (const [k, v] of Object.entries(meta)) fd.append(k, String(v)); return this.req('POST', '/api/evidence', fd); }
}
const tani = new Api(), ternak = new Api(), warga = new Api(), ops = new Api(), kurir = new Api(), maker = new Api(), checker = new Api(), owner = new Api();
await Promise.all([tani.login('tani@supplier.id'), ternak.login('ternak@supplier.id'), warga.login('warga@supplier.id'), ops.login('ops@supplier.id'), kurir.login('kurir@supplier.id'), maker.login('maker@supplier.id'), checker.login('finance@supplier.id'), owner.login('admin@supplier.id')]);
const cats = await owner.get('/api/categories'); const decl = await owner.get('/api/declaration');
const cat = (c) => cats.find((x) => x.code === c);
async function publish(s, code, name, qty, price, attributes) {
  const p = await s.post('/api/supplier/products', { category_id: cat(code).id, name, commodity: name, unit: 'KG', origin: 'Riau' });
  const b = await s.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: 'A', quantity: qty, unit: 'KG', expected_weight_kg: qty, harvest_date: '2026-10-03', availability_date: '2026-10-04', condition: 'Segar', size: 'Sedang', color: 'Hijau', freshness: 'Baru panen (<24 jam)', attributes, price_per_unit: price, min_order_qty: 2 });
  for (const kind of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await s.upload({ owner_type: 'BATCH', kind, batch_id: b.id, taken_at: new Date().toISOString() });
  return s.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: decl.version });
}
const SAYUR = { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Hijau', harvest_date: '2026-10-03', defect_tolerance_pct: 5 };
const TELUR = { size: 'M (50-60g)', shell_condition: 'Utuh & bersih', grade: 'A', production_date: '2026-10-03' };
const addrs = await warga.get('/api/me/addresses');
const addr = addrs[0] ?? await warga.post('/api/me/addresses', { recipient: 'Ibu Wati', phone: '081345678', address: 'Jl. Sudirman 5', city: 'Pekanbaru', province: 'Riau', distance_km: 8 });
const bayam = await publish(tani, 'SAYUR', 'Bayam Hijau Segar', 200, 12000, SAYUR);
const kangkung = await publish(tani, 'SAYUR', 'Kangkung Organik', 150, 9000, SAYUR);
const telur = await publish(ternak, 'TELUR', 'Telur Ayam Negeri', 500, 2200, TELUR);
async function order(items, pay = true) {
  const co = await warga.post('/api/checkout', { address_id: addr.id, items, accept_auto_confirm_policy: true, accept_weight_tolerance: true });
  if (pay) await warga.post(`/api/order-groups/${co.group.id}/pay`, { channel: 'VA' });
  return co;
}
async function acceptAndQc(s, orderId, weight) {
  const t = (await s.get('/api/tasks?status=AWAITING_RESPONSE')).tasks.find((x) => x.order_id === orderId);
  const a = await s.post(`/api/tasks/${t.id}/accept`, {});
  const w = await s.post(`/api/tasks/${a.next.id}/complete`, { result: {} });
  await s.upload({ owner_type: 'QC', kind: 'QC_PHOTO', order_id: orderId, taken_at: new Date().toISOString() });
  return s.post(`/api/tasks/${w.next.id}/qc`, { passed: true, measured_weight_kg: weight, measured_temperature_c: 5, grade: 'A' });
}
async function packAll(s, packingTaskId, qty) { const pkg = await s.post(`/api/tasks/${packingTaskId}/packages`, { quantity: qty, weight_kg: qty }); await s.post(`/api/packages/${pkg.id}/print`, { template: 'A4' }); return s.post(`/api/tasks/${packingTaskId}/complete-packing`); }
const couriers = (await ops.get('/api/dispatch/ready')).couriers; const kurirUser = couriers.find((c) => c.name === 'Kurir Andi');
async function dispatchAndDeliver(orderId, deliver = true) {
  const as = await ops.post(`/api/dispatch/orders/${orderId}/assign`, { courier_user_id: kurirUser.id, cold_chain: true });
  const sh = await kurir.get(`/api/courier/shipments/${as.shipment.id}`);
  for (const p of sh.packages) await kurir.post('/api/scan', { code: p.package_no, action: 'PICKUP', shipment_id: as.shipment.id });
  await kurir.post(`/api/courier/shipments/${as.shipment.id}/pickup`);
  await kurir.post(`/api/courier/shipments/${as.shipment.id}/events`, { location: 'Jl. Riau KM 3', temperature_c: 5 });
  if (!deliver) return as.shipment;
  for (const p of sh.packages) await kurir.post('/api/scan', { code: p.package_no, action: 'DELIVER', shipment_id: as.shipment.id });
  const otp = (await warga.get(`/api/orders/${orderId}/delivery-otp`)).otp;
  await kurir.post(`/api/courier/shipments/${as.shipment.id}/deliver`, { otp, recipient_name: 'Ibu Wati' });
  return as.shipment;
}
// 1) Keranjang berisi (untuk screenshot)
await warga.post('/api/cart/items', { batch_id: bayam.id, quantity: 5 }); await warga.post('/api/cart/items', { batch_id: telur.id, quantity: 30 });
// 2) Menunggu pembayaran
await order([{ batch_id: kangkung.id, quantity: 4 }], false);
// 3) PAID → task ACCEPTANCE menunggu respons mitra
await order([{ batch_id: bayam.id, quantity: 6 }, { batch_id: telur.id, quantity: 20 }]);
// 4) QC selesai → packing terbuka
const o4 = await order([{ batch_id: bayam.id, quantity: 8 }]); const q4 = await acceptAndQc(tani, o4.orders[0].id, 8.05);
// 5) Berat lebih → menunggu keputusan pelanggan
const o5 = await order([{ batch_id: kangkung.id, quantity: 5 }]); await acceptAndQc(tani, o5.orders[0].id, 5.6);
// 6) Siap pickup (dispatch)
const o6 = await order([{ batch_id: bayam.id, quantity: 10 }]); const q6 = await acceptAndQc(tani, o6.orders[0].id, 10); await packAll(tani, q6.next.id, 10);
// 7) Dalam pengiriman (manifest kurir)
const o7 = await order([{ batch_id: telur.id, quantity: 25 }]); const q7 = await acceptAndQc(ternak, o7.orders[0].id, 1.5); await packAll(ternak, q7.next.id, 25); await dispatchAndDeliver(o7.orders[0].id, false);
// 8) Tiba — menunggu konfirmasi (jendela 24 jam berjalan)
const o8 = await order([{ batch_id: bayam.id, quantity: 7 }]); const q8 = await acceptAndQc(tani, o8.orders[0].id, 7); await packAll(tani, q8.next.id, 7); await dispatchAndDeliver(o8.orders[0].id);
// 9) Dikonfirmasi → payment task → diajukan maker (menunggu checker)
const o9 = await order([{ batch_id: kangkung.id, quantity: 6 }]); const q9 = await acceptAndQc(tani, o9.orders[0].id, 6); await packAll(tani, q9.next.id, 6); await dispatchAndDeliver(o9.orders[0].id);
await warga.post(`/api/orders/${o9.orders[0].id}/inspection`, { decision: 'ACCEPT' });
const pt = (await maker.get('/api/finance/payment-tasks')).tasks.find((t) => t.order_id === o9.orders[0].id); await maker.post(`/api/finance/payment-tasks/${pt.id}/submit`);
// 10) Dibayar manual (provider NONE): disetujui checker + mark-paid
const o10 = await order([{ batch_id: telur.id, quantity: 40 }]); const q10 = await acceptAndQc(ternak, o10.orders[0].id, 2.4); await packAll(ternak, q10.next.id, 40); await dispatchAndDeliver(o10.orders[0].id);
await warga.post(`/api/orders/${o10.orders[0].id}/inspection`, { decision: 'ACCEPT' });
const pt10 = (await maker.get('/api/finance/payment-tasks')).tasks.find((t) => t.order_id === o10.orders[0].id); await maker.post(`/api/finance/payment-tasks/${pt10.id}/submit`); await checker.post(`/api/finance/payment-tasks/${pt10.id}/approve`); await checker.post(`/api/finance/payment-tasks/${pt10.id}/mark-paid`, { bank_ref: 'BRI-TRF-DEMO-001' });
// 11) Tiket CS
await warga.post('/api/tickets', { order_id: o8.orders[0].id, category: 'DELIVERY', subject: 'Kurir datang terlambat', body: 'Kurir tiba 2 jam dari jadwal' });
console.log(JSON.stringify({ packing_task: q4.next.id, ready_order: o6.orders[0].id, awaiting_confirm: o8.orders[0].id, weight_pending: o5.orders[0].id, payment_task: pt.id, paid_task: pt10.id, product: bayam.id }));
