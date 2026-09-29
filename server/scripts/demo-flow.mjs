#!/usr/bin/env node
/**
 * Simulasi data demo end-to-end lewat API (server harus berjalan): listing, harvest, RFQ, order berbagai status,
 * inspeksi parsial + retur + dispute + keputusan admin, payout. Jalankan: node scripts/demo-flow.mjs [http://localhost:4000]
 */
const BASE = process.argv[2] || 'http://localhost:4000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), Buffer.alloc(64, 1)]);

class Api {
  constructor() { this.token = ''; }
  async login(email) { const r = await this.req('POST', '/api/auth/login', { email, password: 'Password123' }); this.token = r.token; return r; }
  async req(method, path, body) {
    const headers = { Authorization: `Bearer ${this.token}` };
    let payload;
    if (body instanceof FormData) payload = body; else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + path, { method, headers, body: payload });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
  get(p) { return this.req('GET', p); } post(p, b = {}) { return this.req('POST', p, b); } patch(p, b) { return this.req('PATCH', p, b); }
  async upload(meta, video = false) {
    const fd = new FormData();
    fd.append('file', new Blob([video ? MP4 : PNG], { type: video ? 'video/mp4' : 'image/png' }), video ? 'bukti.mp4' : 'foto.png');
    for (const [k, v] of Object.entries(meta)) fd.append(k, String(v));
    return this.req('POST', '/api/evidence', fd);
  }
}

const admin = new Api(), tani = new Api(), ternak = new Api(), nelayan = new Api(), buyer = new Api(), hotel = new Api();
await Promise.all([admin.login('admin@supplier.id'), tani.login('tani@supplier.id'), ternak.login('ternak@supplier.id'), nelayan.login('nelayan@supplier.id'), buyer.login('buyer@supplier.id'), hotel.login('hotel@supplier.id')]);
const cats = await admin.get('/api/categories');
const cat = (c) => cats.find((x) => x.code === c);
const decl = await admin.get('/api/declaration');
const today = new Date().toISOString().slice(0, 10);

async function publish(s, o) {
  const p = await s.post('/api/supplier/products', { category_id: cat(o.code).id, name: o.name, commodity: o.commodity, variety: o.variety, unit: 'KG', origin: o.origin, production_method: o.method ?? 'Konvensional', certification: o.cert });
  const b = await s.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: o.grade ?? 'A', quantity: o.qty, unit: 'KG', expected_weight_kg: o.qty, harvest_date: today, availability_date: today, condition: o.condition ?? 'Segar', size: 'Sedang', color: o.color ?? '-', freshness: 'Baru panen (<24 jam)', temperature_c: o.temp, attributes: o.attributes, price_per_unit: o.price });
  for (const kind of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await s.upload({ owner_type: 'BATCH', kind, batch_id: b.id, taken_at: new Date().toISOString(), lat: o.lat ?? -0.95, lng: o.lng ?? 100.35, location_consent: true });
  return s.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: decl.version });
}
async function toArrival(b, s, batchId, qty, extra = {}) {
  const o = await b.post('/api/orders', { batch_id: batchId, quantity: qty, distance_km: 120, delivery_address: 'Gudang pusat, Pekanbaru', ...extra });
  await b.post(`/api/orders/${o.id}/confirm`); await b.post(`/api/orders/${o.id}/pay`, { channel: 'VA' });
  await s.post(`/api/orders/${o.id}/pack`, { packaging_type: 'Box berventilasi + ice pack' });
  const pk = await s.post(`/api/orders/${o.id}/pickup`, { carrier: 'Mitra Logistik Sumatera', driver_name: 'Budi', vehicle: 'Box chiller BM 8812 XY', cold_chain: true });
  await s.post(`/api/shipments/${pk.shipment.id}/events`, { event_type: 'CHECKPOINT', location: 'Tol Padang–Sicincin', lat: -0.7, lng: 100.3, temperature_c: 4 });
  await s.post(`/api/shipments/${pk.shipment.id}/events`, { event_type: 'TEMPERATURE', location: 'Rest area Bangkinang', lat: 0.35, lng: 101.0, temperature_c: 6 });
  await s.post(`/api/shipments/${pk.shipment.id}/arrive`);
  return o;
}

console.log('1) Listing supplier…');
const telur = await publish(ternak, { code: 'TELUR', name: 'Telur Ayam Negeri Grade A', commodity: 'Telur', qty: 8000, price: 28000, color: 'Cokelat', origin: 'Kampar, Riau', attributes: { size: 'M (50-60g)', shell_condition: 'Utuh & bersih', grade: 'A', production_date: today, storage: 'Suhu ruang' }, lat: 0.5, lng: 101.4 });
const daging = await publish(ternak, { code: 'DAGING', name: 'Daging Sapi Topside Chilled', commodity: 'Daging sapi', qty: 400, price: 125000, condition: 'Chilled 2°C', temp: 2, origin: 'Pekanbaru', cert: 'Halal MUI', attributes: { cut: 'Topside', weight_per_pack_kg: 5, storage_temperature_c: 2, slaughter_date: today, state: 'Chilled', halal_cert: 'ID-00123' }, lat: 0.5, lng: 101.4 });
const kol = await publish(tani, { code: 'SAYUR', name: 'Kol Bulat Segar', commodity: 'Kol', qty: 3000, price: 7500, color: 'Hijau muda', origin: 'Alahan Panjang, Solok', attributes: { freshness: 'Baru panen (<24 jam)', size: 'Besar', color: 'Hijau muda', harvest_date: today, defect_tolerance_pct: 3, moisture: 'Kering' } });
const cabai = await publish(tani, { code: 'SAYUR', name: 'Cabai Merah Keriting', commodity: 'Cabai', qty: 1200, price: 42000, color: 'Merah', origin: 'Bukittinggi', attributes: { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Merah', harvest_date: today, defect_tolerance_pct: 2 } });
const tongkol = await publish(nelayan, { code: 'IKAN', name: 'Ikan Tongkol Segar', commodity: 'Tongkol', qty: 5000, price: 32000, condition: 'Fresh on ice 2°C', temp: 2, origin: 'Batam', attributes: { species: 'Euthynnus affinis', weight_per_fish_kg: 0.8, state: 'Fresh', catch_date: today, temperature_c: 2 }, lat: 1.1, lng: 104.0 });
const udang = await publish(nelayan, { code: 'IKAN', name: 'Udang Vaname Size 40', commodity: 'Udang', qty: 1500, price: 78000, condition: 'Frozen -18°C', temp: -18, origin: 'Batam', attributes: { species: 'Litopenaeus vannamei', weight_per_fish_kg: 0.025, state: 'Frozen', catch_date: today, temperature_c: -18 }, lat: 1.1, lng: 104.0 });

console.log('2) Upcoming harvest (beras)…');
{
  const p = await tani.post('/api/supplier/products', { category_id: cat('BERAS').id, name: 'Beras Solok Anak Daro', commodity: 'Beras', variety: 'Anak Daro', unit: 'KG', origin: 'Solok' });
  const b = await tani.post('/api/supplier/batches', { product_id: p.id, type: 'HARVEST', quantity: 5000, expected_weight_kg: 5000, price_per_unit: 14500, harvest: { planting_date: '2026-06-15', expected_harvest_date: '2026-10-12', expected_quantity: 5000, expected_grade: 'Premium', expected_quality: 'Kadar air ≤14%, patah ≤5%', current_condition: 'Bulir menguning 70%', forecast_confidence: 80 } });
  await tani.upload({ owner_type: 'HARVEST_CURRENT', kind: 'CURRENT', batch_id: b.id, taken_at: new Date().toISOString() });
  await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: decl.version });
}

console.log('3) RFQ + negosiasi…');
{
  const rfq = await buyer.post('/api/rfqs', { category_id: cat('TELUR').id, commodity: 'Telur', quantity: 2000, unit: 'KG', target_price: 26000, required_grade: 'A', delivery_address: 'Central kitchen Pekanbaru', delivery_region: 'Pekanbaru', distance_km: 60, needed_by: '2026-10-08' });
  const qt = await ternak.post(`/api/rfqs/${rfq.id}/quotations`, { batch_id: telur.id, price_per_unit: 27500, quantity: 2000, message: 'Harga grade A, kirim bertahap 2x' });
  await buyer.post(`/api/quotations/${qt.id}/counter`, { price_per_unit: 26800, message: 'Kontrak rutin bulanan' });
  const rfq2 = await hotel.post('/api/rfqs', { category_id: cat('IKAN').id, commodity: 'Udang', quantity: 300, unit: 'KG', target_price: 75000, delivery_address: 'Hotel Bukittinggi Indah', delivery_region: 'Bukittinggi', distance_km: 180 });
  void rfq2;
}

console.log('4) Order sukses (accept penuh)…');
const o1 = await toArrival(buyer, ternak, telur.id, 1000, { optional_service_codes: ['COLD_CHAIN'], promo_code: 'HEMAT5' });
await buyer.post(`/api/orders/${o1.id}/inspection`, { decision: 'ACCEPT', notes: 'Sesuai deklarasi' });
const o1b = await toArrival(hotel, tani, kol.id, 800);
await hotel.post(`/api/orders/${o1b.id}/inspection`, { decision: 'ACCEPT' });

console.log('5) Order partial accept 1000 → 920/80 + dispute + keputusan admin (SUPPLIER)…');
const o2 = await toArrival(buyer, nelayan, tongkol.id, 1000);
await buyer.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: o2.id, taken_at: new Date().toISOString() });
await buyer.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: o2.id, taken_at: new Date().toISOString() });
await buyer.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_VIDEO', order_id: o2.id, taken_at: new Date().toISOString() }, true);
const insp2 = await buyer.post(`/api/orders/${o2.id}/inspection`, { decision: 'PARTIAL_ACCEPT', accepted_quantity: 920, reason_code: 'NOT_FRESH', description: '80 kg insang pucat & berbau', measured_weight_kg: 996, measured_temperature_c: 8 });
await nelayan.post(`/api/returns/${insp2.return_case.id}/dispute`, { statement: 'Ikan diserahkan pada suhu 2°C dengan es cukup; mohon cek log suhu pengiriman.' });
const dec2 = await admin.post(`/api/returns/${insp2.return_case.id}/decide`, { decision: 'APPROVED', fault_attribution: 'SUPPLIER', notes: 'Video penerimaan menunjukkan insang pucat; suhu perjalanan terjaga (4–6°C). Penyebab kualitas sumber.' });
await admin.post(`/api/returns/${insp2.return_case.id}/pickup`, { carrier: 'Mitra Logistik Sumatera', driver_name: 'Andi' });

console.log('6) Order ditolak penuh, atribusi LOGISTICS (masih review)…');
const o3 = await toArrival(hotel, ternak, daging.id, 60);
await hotel.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: o3.id, taken_at: new Date().toISOString() });
await hotel.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_VIDEO', order_id: o3.id, taken_at: new Date().toISOString() }, true);
await hotel.post(`/api/orders/${o3.id}/inspection`, { decision: 'REJECT', reason_code: 'TEMPERATURE_ISSUE', description: 'Seluruh kiriman hangat, suhu 17°C saat tiba', measured_temperature_c: 17 });

console.log('7) Order berjalan (menunggu bayar, packing, in-transit, tiba)…');
const oA = await buyer.post('/api/orders', { batch_id: cabai.id, quantity: 300, distance_km: 90 }); await buyer.post(`/api/orders/${oA.id}/confirm`);
const oB = await hotel.post('/api/orders', { batch_id: udang.id, quantity: 200, distance_km: 180, optional_service_codes: ['COLD_CHAIN', 'INSURANCE'] }); await hotel.post(`/api/orders/${oB.id}/confirm`); await hotel.post(`/api/orders/${oB.id}/pay`, { channel: 'QRIS' });
const oC = await buyer.post('/api/orders', { batch_id: kol.id, quantity: 500, distance_km: 200 }); await buyer.post(`/api/orders/${oC.id}/confirm`); await buyer.post(`/api/orders/${oC.id}/pay`); await tani.post(`/api/orders/${oC.id}/pack`, {});
const pkC = await tani.post(`/api/orders/${oC.id}/pickup`, { carrier: 'Mitra Logistik Sumatera', driver_name: 'Rudi' }); await tani.post(`/api/shipments/${pkC.shipment.id}/events`, { event_type: 'CHECKPOINT', location: 'Payakumbuh' });
await toArrival(buyer, ternak, telur.id, 400);

console.log('8) Payout supplier ternak…');
{
  const orgs = await admin.get('/api/admin/organizations?type=SUPPLIER');
  const ternakOrg = orgs.find((o) => o.name === 'PT Ternak Nusantara');
  await admin.post('/api/admin/payouts/run', { supplier_id: ternakOrg.id });
}
await admin.post('/api/admin/quality/recompute', {});
const rec = await admin.get('/api/admin/reconcile');
console.log(`\nSelesai. Rekonsiliasi: balanced=${rec.balanced} variance=${rec.variance} moneyIn=${rec.moneyIn} moneyOut=${rec.moneyOut} liabilities=${rec.liabilities} tax=${rec.tax} netRevenue=${rec.netRevenue}`);
console.log(`Keputusan retur contoh: refund buyer Rp${dec2.adjustment.computed.refundToBuyer.toLocaleString('id-ID')}, potongan supplier Rp${dec2.adjustment.computed.supplierDeduction.toLocaleString('id-ID')}`);
