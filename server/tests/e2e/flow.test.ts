/**
 * E2E — Definition of Done Supplier.id (21 skenario) terhadap PostgreSQL nyata.
 * Prinsip: DECLARE → PROVE → DELIVER → INSPECT → EVIDENCE → SETTLE
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/app';
import { migrate, resetDatabase, pool } from '../../src/db';
import { seed } from '../../src/seed';
import { Api, sum } from '../helpers';

process.env.UPLOAD_DIR = '/tmp/supplier-id-test-uploads';
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/supplier_id_test';
process.env.DATABASE_URL = TEST_DB;

const app = createApp();
const admin = new Api(app), tani = new Api(app), ternak = new Api(app), buyer = new Api(app), hotel = new Api(app);
let categories: any[] = [];
let declaration: any;

beforeAll(async () => {
  await resetDatabase(TEST_DB);
  await migrate(TEST_DB);
  await seed();
  await Promise.all([admin.login('admin@supplier.id'), tani.login('tani@supplier.id'), ternak.login('ternak@supplier.id'), buyer.login('buyer@supplier.id'), hotel.login('hotel@supplier.id')]);
  categories = await admin.get('/api/categories');
  declaration = await admin.get('/api/declaration');
});
afterAll(async () => { await pool.end(); });

const cat = (code: string) => categories.find((c) => c.code === code);

/** Supplier mendaftarkan READY STOCK lengkap: produk → batch → 3 foto → deklarasi → publish. */
async function publishReadyStock(s: Api, o: { code: string; name: string; commodity: string; qty: number; price: number; weight?: number; attributes: any; grade?: string }) {
  const p = await s.post('/api/supplier/products', { category_id: cat(o.code).id, name: o.name, commodity: o.commodity, unit: 'KG', origin: 'Sumatera', production_method: 'Konvensional' });
  const b = await s.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: o.grade ?? 'A', quantity: o.qty, unit: 'KG', expected_weight_kg: o.weight ?? o.qty, harvest_date: '2026-09-25', availability_date: '2026-09-26', condition: 'Segar', size: 'Sedang', color: 'Hijau', freshness: 'Baru panen (<24 jam)', attributes: o.attributes, price_per_unit: o.price });
  for (const kind of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await s.upload({ owner_type: 'BATCH', kind, batch_id: b.id, taken_at: new Date().toISOString(), lat: -0.95, lng: 100.35, location_consent: true });
  return s.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version });
}

/** Order langsung → confirm → pay → pack → pickup → tracking → arrive. */
async function orderToArrival(b: Api, s: Api, batchId: string, qty: number, extra: any = {}) {
  const o = await b.post('/api/orders', { batch_id: batchId, quantity: qty, distance_km: 100, ...extra });
  const confirmed = await b.post(`/api/orders/${o.id}/confirm`);
  expect(confirmed.status).toBe('PENDING_PAYMENT');
  const paid = await b.post(`/api/orders/${o.id}/pay`, { channel: 'VA' });
  expect(paid.order.status).toBe('PAID');
  await s.post(`/api/orders/${o.id}/pack`, { packaging_type: 'Box berventilasi' });
  const pk = await s.post(`/api/orders/${o.id}/pickup`, { carrier: 'Mitra Logistik', driver_name: 'Budi', vehicle: 'Box chiller' });
  await s.post(`/api/shipments/${pk.shipment.id}/events`, { event_type: 'CHECKPOINT', location: 'Gerbang tol Padang', lat: -0.9, lng: 100.4, temperature_c: 6 });
  const arrived = await s.post(`/api/shipments/${pk.shipment.id}/arrive`);
  expect(arrived.status).toBe('ARRIVED_WAITING_INSPECTION');
  return { order: confirmed, shipment: pk.shipment };
}

describe('A–D. Quality control: self declaration, foto wajib, harvest, jaminan retur', () => {
  it('3. deklarasi kualitas: publish ditolak tanpa foto & atribut kategori; stock image ditolak', async () => {
    const p = await tani.post('/api/supplier/products', { category_id: cat('SAYUR').id, name: 'Kol Segar', commodity: 'Kol', unit: 'KG' });
    const b = await tani.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: 'A', quantity: 500, expected_weight_kg: 500, harvest_date: '2026-09-25', condition: 'Segar', price_per_unit: 8000, attributes: { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Hijau', harvest_date: '2026-09-25' } });
    // atribut defect_tolerance_pct (wajib untuk SAYUR) belum diisi & belum ada foto
    const r1 = await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version }, 400);
    expect(r1.error).toBe('DECLARATION_INCOMPLETE');
    expect(r1.details.missing_fields).toContain('attributes.defect_tolerance_pct');
    expect(r1.details.missing_photo_kinds).toEqual(['OVERALL', 'CLOSEUP', 'PACKAGING']);
    await tani.patch(`/api/supplier/batches/${b.id}`, { attributes: { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Hijau', harvest_date: '2026-09-25', defect_tolerance_pct: 3 } });
    // stock image ditolak
    const r2 = await tani.upload({ owner_type: 'BATCH', kind: 'OVERALL', batch_id: b.id, is_stock_image: true }, false, 400);
    expect(r2.error).toBe('STOCK_IMAGE_NOT_ALLOWED');
    await tani.upload({ owner_type: 'BATCH', kind: 'OVERALL', batch_id: b.id });
    await tani.upload({ owner_type: 'BATCH', kind: 'CLOSEUP', batch_id: b.id });
    const r3 = await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version }, 400);
    expect(r3.details.missing_photo_kinds).toEqual(['PACKAGING']);
    await tani.upload({ owner_type: 'BATCH', kind: 'PACKAGING', batch_id: b.id, lat: -0.95, lng: 100.35, location_consent: true });
    const pub = await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version });
    expect(pub.status).toBe('READY_FOR_ORDER');
    const detail = await tani.get(`/api/supplier/batches/${b.id}`);
    expect(detail.acceptance.declaration_version).toBe(declaration.version);
    expect(detail.acceptance.ip_address).toBeTruthy();
    expect(detail.photos.length).toBe(3);
    // lokasi hanya tersimpan bila ada persetujuan
    expect(detail.photos.find((x: any) => x.kind === 'OVERALL').lat).toBeNull();
    expect(Number(detail.photos.find((x: any) => x.kind === 'PACKAGING').lat)).toBeCloseTo(-0.95);
    // muncul di listing publik
    const listings = await buyer.get('/api/listings?category=SAYUR');
    expect(listings.some((l: any) => l.id === b.id)).toBe(true);
  });

  it('2. upcoming harvest → pre-harvest update → final declaration → transaksi', async () => {
    const p = await tani.post('/api/supplier/products', { category_id: cat('BERAS').id, name: 'Beras Solok Premium', commodity: 'Beras', unit: 'KG' });
    const b = await tani.post('/api/supplier/batches', { product_id: p.id, type: 'HARVEST', quantity: 2000, expected_weight_kg: 2000, price_per_unit: 14000,
      harvest: { planting_date: '2026-06-01', expected_harvest_date: '2026-10-05', expected_quantity: 2000, expected_grade: 'Premium', expected_quality: 'Kadar air ≤14%', current_condition: 'Bulir mulai menguning', forecast_confidence: 80 } });
    // publish upcoming butuh minimal 1 foto kondisi saat ini
    const r = await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version }, 400);
    expect(r.details.missing_photo_kinds).toEqual(['CURRENT']);
    await tani.upload({ owner_type: 'HARVEST_CURRENT', kind: 'CURRENT', batch_id: b.id });
    const up = await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version });
    expect(up.status).toBe('UPCOMING');
    const listing = await buyer.get('/api/listings?status=UPCOMING');
    expect(listing.find((l: any) => l.id === b.id).harvest_stage).toBe('UPCOMING');
    // belum bisa dipesan
    const no = await buyer.post('/api/orders', { batch_id: b.id, quantity: 100 }, 409);
    expect(no.error).toBe('BATCH_NOT_READY_FOR_ORDER');
    // pre-harvest update wajib foto terbaru
    await tani.post(`/api/supplier/batches/${b.id}/harvest/pre-update`, { current_condition: 'Siap panen 90%' }, 400);
    await tani.upload({ owner_type: 'HARVEST_PRE', kind: 'PRE_HARVEST', batch_id: b.id });
    const pre = await tani.post(`/api/supplier/batches/${b.id}/harvest/pre-update`, { current_condition: 'Siap panen 90%', forecast_confidence: 92, expected_quantity: 1900 });
    expect(pre.stage).toBe('PRE_HARVEST_UPDATED');
    // final: wajib minimal 3 foto final
    for (const k of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await tani.upload({ owner_type: 'HARVEST_FINAL', kind: 'FINAL', batch_id: b.id });
    const fin = await tani.post(`/api/supplier/batches/${b.id}/harvest/finalize`, { actual_quantity: 1850, actual_grade: 'Premium', actual_weight_kg: 1850, actual_condition: 'Kering, bersih', actual_harvest_date: '2026-10-04', attributes: { variety: 'Anak Daro', moisture_pct: 13.5, broken_pct: 4, milling_date: '2026-10-05' }, accepted: true, declaration_version: declaration.version });
    expect(fin.status).toBe('READY_FOR_ORDER');
    expect(Number(fin.available_quantity)).toBe(1850);
    // transaksi dari hasil panen
    const { order } = await orderToArrival(hotel, tani, b.id, 300);
    const insp = await hotel.post(`/api/orders/${order.id}/inspection`, { decision: 'ACCEPT' });
    expect(insp.order.status).toBe('SETTLED');
    const q = await admin.get('/api/admin/quality');
    const tq = q.find((x: any) => x.supplier_name === 'Kelompok Tani Sumber Rezeki');
    expect(Number(tq.metrics.declaration_accuracy)).toBeCloseTo(97.37, 1); // 1850 aktual vs 1900 forecast terakhir (pre-harvest update) → 97.37%
  });
});

describe('K–S. Monetization, pricing, transparansi, snapshot', () => {
  let batchTelur: string, orderOld: any, orderNew: any;

  it('13/17/18/19/20. order memuat platform fee 15%, packaging, logistics, payment fee, pajak per komponen; total = jumlah komponen', async () => {
    const pub = await publishReadyStock(ternak, { code: 'TELUR', name: 'Telur Ayam Negeri', commodity: 'Telur', qty: 5000, price: 28000, attributes: { size: 'M (50-60g)', shell_condition: 'Utuh & bersih', grade: 'A', production_date: '2026-09-26' } });
    batchTelur = pub.id;
    const preview = await buyer.post('/api/orders/preview', { batch_id: batchTelur, quantity: 1000, distance_km: 100, optional_service_codes: ['COLD_CHAIN'], promo_code: 'HEMAT5' });
    expect(preview.platformFeeRate).toBe(15);
    expect(preview.productValue).toBe(28_000_000);
    expect(preview.platformFeeAmount).toBe(4_200_000);
    expect(preview.packagingAmount).toBe(250_000);            // 1.000 kg × 250
    expect(preview.logisticsAmount).toBe(150_000 + 3500 * 100 + 350 * 1000);
    expect(preview.optionalAmount).toBe(500_000);             // cold chain 500/kg
    expect(preview.discountAmount).toBe(500_000);             // HEMAT5 maks 500.000
    expect(preview.paymentFeeAmount).toBeGreaterThan(0);
    // PPN: ternak = PKP tapi TELUR = kebutuhan pokok → produk dibebaskan; jasa platform kena 11%
    const tl = Object.fromEntries(preview.taxLines.map((t: any) => [t.component, t]));
    expect(tl.PRODUCT.taxable).toBe(false);
    expect(tl.PLATFORM_FEE.amount).toBe(462_000);
    expect(tl.PACKAGING.amount).toBe(27_500);
    expect(tl.PAYMENT_FEE.taxable).toBe(false);
    expect(preview.totalAmount).toBe(sum([preview.productValue, preview.platformFeeAmount, preview.packagingAmount, preview.logisticsAmount, preview.paymentFeeAmount, preview.optionalAmount, -preview.discountAmount, preview.taxAmount]));
    // daging (STANDARD) dari supplier PKP → PPN produk
    const pubDaging = await publishReadyStock(ternak, { code: 'DAGING', name: 'Daging Sapi Chilled', commodity: 'Daging sapi', qty: 300, price: 120000, attributes: { cut: 'Topside', weight_per_pack_kg: 5, storage_temperature_c: 2, slaughter_date: '2026-09-27', state: 'Chilled' } });
    const pv2 = await buyer.post('/api/orders/preview', { batch_id: pubDaging.id, quantity: 100, distance_km: 50 });
    expect(pv2.taxLines.find((t: any) => t.component === 'PRODUCT').amount).toBe(1_320_000); // 11% × 12.000.000
  });

  it('1/5. transaksi normal sukses: bayar → packing → pickup → tracking → tiba → terima penuh → SETTLED, ledger tercatat', async () => {
    const { order } = await orderToArrival(buyer, ternak, batchTelur, 1000, { optional_service_codes: ['COLD_CHAIN'], promo_code: 'HEMAT5' });
    orderOld = order;
    expect(order.pricing_locked_at).toBeTruthy();
    expect(Number(order.platform_fee_rate)).toBe(15);
    expect(Number(order.platform_fee_amount)).toBe(4_200_000);
    const insp = await buyer.post(`/api/orders/${order.id}/inspection`, { decision: 'ACCEPT' });
    expect(insp.order.status).toBe('SETTLED');
    expect(Number(insp.order.accepted_quantity)).toBe(1000);
    const d = await admin.get(`/api/orders/${order.id}`);
    expect(d.payments[0].status).toBe('PAID');
    expect(Number(d.payments[0].amount)).toBe(Number(order.total_amount));
    const types = d.ledger.map((e: any) => e.journal_type);
    expect(types).toContain('BUYER_PAYMENT'); expect(types).toContain('PROVIDER_FEE'); expect(types).toContain('PACKAGING_COST'); expect(types).toContain('LOGISTICS_COST');
    const cashIn = d.ledger.filter((e: any) => e.account === 'CASH' && e.side === 'DEBIT').reduce((a: number, e: any) => a + Number(e.amount), 0);
    expect(cashIn).toBe(Number(order.total_amount));
    const rec = await admin.get(`/api/orders/${order.id}/reconcile`);
    expect(rec.balanced).toBe(true);
    expect(rec.variance).toBe(0);
    expect(rec.moneyIn).toBe(Number(order.total_amount));
  });

  it('14/15/16. admin mengubah fee 15% → 12% (effective date, previous value, reason, audit); order lama tetap 15%, order baru 12%', async () => {
    const fees = await admin.get('/api/admin/fees');
    expect(Number(fees.current.rate_percent)).toBe(15);
    const changed = await admin.post('/api/admin/fees', { rate_percent: 12, scope_type: 'GLOBAL', reason: 'Promo Q4 penetrasi pasar' });
    expect(Number(changed.previous_value)).toBe(15);
    expect(changed.status).toBe('ACTIVE');
    expect(changed.created_by).toBeTruthy();
    const after = await admin.get('/api/admin/fees');
    expect(Number(after.current.rate_percent)).toBe(12);
    const logs = await admin.get('/api/admin/audit-logs');
    expect(logs.some((l: any) => l.entity === 'fee_configs' && l.entity_id === changed.id && l.reason === 'Promo Q4 penetrasi pasar')).toBe(true);
    // order lama tidak berubah
    const old = await admin.get(`/api/orders/${orderOld.id}`);
    expect(Number(old.platform_fee_rate)).toBe(15);
    expect(Number(old.platform_fee_amount)).toBe(4_200_000);
    expect(old.pricing_snapshot.fee_config.id).toBe(fees.current.id);
    // order baru memakai 12%
    const { order } = await orderToArrival(buyer, ternak, batchTelur, 200);
    orderNew = order;
    expect(Number(order.platform_fee_rate)).toBe(12);
    expect(Number(order.platform_fee_amount)).toBe(200 * 28000 * 0.12);
    expect(order.pricing_snapshot.fee_config.id).toBe(changed.id);
    // fee di masa depan tidak dipakai sekarang
    const future = await admin.post('/api/admin/fees', { rate_percent: 18, scope_type: 'GLOBAL', effective_from: '2099-01-01T00:00:00Z', reason: 'Uji effective date' });
    expect(future.status).toBe('ACTIVE');
    const now = await admin.get('/api/admin/fees');
    expect(Number(now.current.rate_percent)).toBe(12);
    // override per supplier (arsitektur R) tanpa redesign DB
    const org = (await admin.get('/api/admin/organizations?type=SUPPLIER')).find((o: any) => o.name === 'PT Ternak Nusantara');
    await admin.post('/api/admin/fees', { rate_percent: 10, scope_type: 'SUPPLIER', scope_ref: org.id, reason: 'Kontrak khusus' });
    const pv = await buyer.post('/api/orders/preview', { batch_id: batchTelur, quantity: 10 });
    expect(pv.platformFeeRate).toBe(10);
    expect(pv.feeConfig.scope_type).toBe('SUPPLIER');
    await admin.post('/api/admin/fees', { rate_percent: 10, scope_type: 'SUPPLIER', scope_ref: org.id, effective_to: '2000-01-02T00:00:00Z', effective_from: '2000-01-01T00:00:00Z', reason: 'nonaktifkan override' });
    // approval workflow
    await admin.put('/api/admin/settings/fee.change_requires_approval', { value: true, reason: 'Aktifkan dual control' });
    const pend = await admin.post('/api/admin/fees', { rate_percent: 12.5, scope_type: 'GLOBAL', reason: 'Butuh persetujuan' });
    expect(pend.status).toBe('PENDING_APPROVAL');
    expect(Number((await admin.get('/api/admin/fees')).current.rate_percent)).toBe(12);
    await admin.post(`/api/admin/fees/${pend.id}/approve`, {}, 409); // pembuat tidak boleh menyetujui sendiri
    await admin.post(`/api/admin/fees/${pend.id}/reject`, { reason: 'Ditolak Finance' });
    await admin.put('/api/admin/settings/fee.change_requires_approval', { value: false });
    // selesaikan orderNew agar bersih
    await buyer.post(`/api/orders/${orderNew.id}/inspection`, { decision: 'ACCEPT' });
  });
});

describe('E–J, T. Inspeksi, retur parsial/penuh, evidence, dispute, refund, payout, quality score', () => {
  let batchIkan: string, partialOrder: any, retCase: any, rejectedOrder: any;

  it('4/6/8. inspeksi buyer: klaim tanpa foto+video ditolak; partial accept 1.000 → 920/80 membuat return case dengan eligibility otomatis', async () => {
    const pub = await publishReadyStock(tani, { code: 'IKAN', name: 'Ikan Tongkol Segar', commodity: 'Tongkol', qty: 3000, price: 32000, attributes: { species: 'Euthynnus affinis', weight_per_fish_kg: 0.8, state: 'Fresh', catch_date: '2026-09-27', temperature_c: 2 } });
    batchIkan = pub.id;
    const { order } = await orderToArrival(buyer, tani, batchIkan, 1000);
    partialOrder = order;
    const r1 = await buyer.post(`/api/orders/${order.id}/inspection`, { decision: 'PARTIAL_ACCEPT', accepted_quantity: 920, reason_code: 'NOT_FRESH', description: '80 kg berbau' }, 400);
    expect(r1.error).toBe('RECEIVING_EVIDENCE_REQUIRED');
    await buyer.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: order.id, taken_at: new Date().toISOString() });
    const r2 = await buyer.post(`/api/orders/${order.id}/inspection`, { decision: 'PARTIAL_ACCEPT', accepted_quantity: 920, reason_code: 'NOT_FRESH' }, 400);
    expect(r2.details.video).toBe(false);
    await buyer.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_VIDEO', order_id: order.id }, true);
    const insp = await buyer.post(`/api/orders/${order.id}/inspection`, { decision: 'PARTIAL_ACCEPT', accepted_quantity: 920, reason_code: 'NOT_FRESH', description: '80 kg tidak segar, insang pucat', measured_weight_kg: 995, measured_temperature_c: 9 });
    expect(insp.order.status).toBe('PARTIALLY_ACCEPTED');
    expect(Number(insp.order.accepted_quantity)).toBe(920);
    expect(Number(insp.order.rejected_quantity)).toBe(80);
    retCase = insp.return_case;
    expect(retCase.status).toBe('EVIDENCE_REVIEW');
    expect(Number(retCase.quantity_affected)).toBe(80);
    expect(retCase.eligibility.eligible).toBe(true);
    expect(retCase.eligibility.checks.has_photo && retCase.eligibility.checks.has_video).toBe(true);
  });

  it('G/10. dispute: supplier membantah; admin melihat side-by-side deklarasi vs bukti penerimaan', async () => {
    const d = await tani.post(`/api/returns/${retCase.id}/dispute`, { statement: 'Ikan dikirim suhu 2°C, foto pickup menunjukkan segar.' });
    expect(d.status).toBe('OPEN');
    expect((await admin.get(`/api/orders/${partialOrder.id}`)).status).toBe('DISPUTED');
    const cmp = await admin.get(`/api/returns/${retCase.id}/evidence-comparison`);
    expect(cmp.before_delivery.supplier_photos.length).toBe(3);
    expect(cmp.before_delivery.declared.grade).toBe('A');
    expect(cmp.delivery.pickup_timestamp).toBeTruthy();
    expect(cmp.delivery.events.length).toBeGreaterThanOrEqual(3);
    expect(cmp.at_receiving.buyer_photos.length).toBe(1);
    expect(cmp.at_receiving.buyer_videos.length).toBe(1);
    expect(cmp.at_receiving.reason_code).toBe('NOT_FRESH');
    expect(cmp.signals.some((s: string) => s.includes('Suhu'))).toBe(true); // 6°C perjalanan vs deklarasi 2°C
    expect(cmp.dispute.status).toBe('OPEN');
    expect(cmp.guidance).toMatch(/Jangan menyimpulkan/);
  });

  it('11/12/T. keputusan admin (kesalahan SUPPLIER) → financial adjustment prorata, refund ke buyer, potongan hak supplier, ledger seimbang', async () => {
    const before = await tani.get('/api/supplier/dashboard');
    const dec = await admin.post(`/api/returns/${retCase.id}/decide`, { decision: 'APPROVED', fault_attribution: 'SUPPLIER', notes: 'Video menunjukkan insang pucat; suhu kirim sesuai, penyebab kualitas sumber.' });
    expect(dec.return_case.status).toBe('APPROVED');
    expect(dec.return_case.fault_attribution).toBe('SUPPLIER');
    const adj = dec.adjustment.computed;
    expect(adj.ratio).toBe(0.08);
    const comp = Object.fromEntries(adj.components.map((c: any) => [c.component, c]));
    expect(comp.PRODUCT.refund).toBe(80 * 32000);                       // 2.560.000
    expect(comp.PLATFORM_FEE.refund).toBe(Number(partialOrder.platform_fee_amount) * 0.08);
    expect(comp.LOGISTICS.refund).toBe(0);                              // logistik awal tidak direfund (kesalahan supplier)
    expect(comp.PAYMENT_FEE.refund).toBe(0);
    expect(adj.supplierDeduction).toBe(comp.PRODUCT.refund + adj.returnLogistics.cost);
    expect(adj.returnLogistics.bearer).toBe('SUPPLIER');
    const d = await admin.get(`/api/orders/${partialOrder.id}`);
    expect(d.payments[0].status).toBe('PARTIALLY_REFUNDED');
    const refundOut = d.ledger.filter((e: any) => e.journal_type === 'REFUND_PAID' && e.account === 'CASH').reduce((a: number, e: any) => a + Number(e.amount), 0);
    expect(refundOut).toBe(adj.refundToBuyer);
    expect(d.adjustments.length).toBe(1);
    expect(Number(d.adjustments[0].refund_to_buyer)).toBe(adj.refundToBuyer);
    const rec = await admin.get(`/api/orders/${partialOrder.id}/reconcile`);
    expect(rec.balanced).toBe(true);
    // dispute resolved
    expect((await admin.get(`/api/returns/${retCase.id}`)).dispute.status).toBe('RESOLVED');
    // supplier dashboard: hak berkurang sebesar potongan
    const after = await tani.get('/api/supplier/dashboard');
    expect(after.summary.adjustment - before.summary.adjustment).toBe(adj.supplierDeduction);
    const row = after.orders.find((o: any) => o.id === partialOrder.id);
    expect(Number(row.supplier_receivable)).toBe(Number(partialOrder.product_value) - adj.supplierDeduction);
  });

  it('9. return logistics: pickup → live tracking → supplier menerima → CASE CLOSED → order SETTLED', async () => {
    const s = await admin.post(`/api/returns/${retCase.id}/pickup`, { carrier: 'Mitra Logistik', driver_name: 'Andi' });
    expect(s.type).toBe('RETURN');
    expect((await admin.get(`/api/returns/${retCase.id}`)).case.status).toBe('PICKUP_SCHEDULED');
    await admin.post(`/api/shipments/${s.id}/events`, { event_type: 'CHECKPOINT', location: 'Jalan lintas Sumatera' });
    expect((await admin.get(`/api/returns/${retCase.id}`)).case.status).toBe('IN_TRANSIT');
    const rc = await tani.post(`/api/returns/${retCase.id}/receive`, { notes: 'Diterima 80 kg' });
    expect(rc.status).toBe('CLOSED');
    expect((await admin.get(`/api/orders/${partialOrder.id}`)).status).toBe('SETTLED');
  });

  it('7. penolakan penuh dengan atribusi LOGISTICS: supplier tetap dibayar penuh, refund buyer termasuk logistik, klaim ke penyedia logistik', async () => {
    const { order } = await orderToArrival(hotel, tani, batchIkan, 200);
    rejectedOrder = order;
    await hotel.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: order.id });
    await hotel.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_VIDEO', order_id: order.id }, true);
    const insp = await hotel.post(`/api/orders/${order.id}/inspection`, { decision: 'REJECT', reason_code: 'TEMPERATURE_ISSUE', description: 'Seluruh kiriman hangat, es mencair', measured_temperature_c: 18 });
    expect(insp.order.status).toBe('REJECTED');
    expect(Number(insp.return_case.quantity_affected)).toBe(200);
    const dec = await admin.post(`/api/returns/${insp.return_case.id}/decide`, { decision: 'APPROVED', fault_attribution: 'LOGISTICS', notes: 'Log suhu perjalanan 6°C→18°C; cold chain gagal.' });
    const adj = dec.adjustment.computed;
    expect(adj.supplierDeduction).toBe(0);
    expect(adj.logisticsRecovery).toBe(Number(order.product_value));
    const comp = Object.fromEntries(adj.components.map((c: any) => [c.component, c]));
    expect(comp.LOGISTICS.refund).toBe(Number(order.logistics_amount));
    expect(adj.returnLogistics.bearer).toBe('LOGISTICS');
    const d = await admin.get(`/api/orders/${order.id}`);
    expect(d.payments[0].status).not.toBe('PAID');
    expect(d.ledger.some((e: any) => e.component === 'LOGISTICS_RECOVERY')).toBe(true);
    expect((await admin.get(`/api/orders/${order.id}/reconcile`)).balanced).toBe(true);
    await admin.post(`/api/returns/${insp.return_case.id}/pickup`);
    await tani.post(`/api/returns/${insp.return_case.id}/receive`);
    expect((await admin.get(`/api/orders/${order.id}`)).status).toBe('SETTLED');
  });

  it('klaim ditolak admin (BUYER_RECEIVING): tidak ada refund, order settled dengan hak supplier penuh', async () => {
    const { order } = await orderToArrival(hotel, tani, batchIkan, 50);
    await hotel.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_PHOTO', order_id: order.id });
    await hotel.upload({ owner_type: 'INSPECTION', kind: 'RECEIVING_VIDEO', order_id: order.id }, true);
    const insp = await hotel.post(`/api/orders/${order.id}/inspection`, { decision: 'PARTIAL_ACCEPT', accepted_quantity: 45, reason_code: 'OTHER', description: 'Dibiarkan di dermaga 3 jam' });
    const dec = await admin.post(`/api/returns/${insp.return_case.id}/decide`, { decision: 'REJECTED', fault_attribution: 'BUYER_RECEIVING', notes: 'Video menunjukkan barang dibiarkan tanpa pendingin setelah serah terima.' });
    expect(dec.adjustment).toBeNull();
    expect(dec.return_case.status).toBe('CLOSED');
    expect((await admin.get(`/api/orders/${order.id}`)).status).toBe('SETTLED');
  });

  it('12/O. payout supplier: PENDING → PAID sesuai hak bersih setelah adjustment; dashboard supplier menampilkan product value, adjustment, receivable, paid, pending', async () => {
    const before = await tani.get('/api/supplier/dashboard');
    expect(before.summary.pending).toBeGreaterThan(0);
    const pend = await admin.get('/api/admin/payouts');
    const row = pend.pending.find((p: any) => p.supplier_name === 'Kelompok Tani Sumber Rezeki');
    expect(Number(row.payable_balance)).toBe(before.summary.pending);
    const po = await admin.post('/api/admin/payouts/run', { supplier_id: row.supplier_id });
    expect(po.status).toBe('PAID');
    expect(Number(po.amount)).toBe(before.summary.pending);
    const after = await tani.get('/api/supplier/dashboard');
    expect(after.summary.pending).toBe(0);
    expect(after.summary.paid).toBe(before.summary.pending);
    expect(after.summary.supplier_receivable).toBe(after.summary.product_value - after.summary.adjustment);
    await admin.post('/api/admin/payouts/run', { supplier_id: row.supplier_id }, 409); // tidak ada lagi yang harus dibayar
  });

  it('J. quality score internal & enforcement configurable', async () => {
    const q = await admin.get('/api/admin/quality');
    const tq = q.find((x: any) => x.supplier_name === 'Kelompok Tani Sumber Rezeki');
    expect(Number(tq.score)).toBeGreaterThan(0);
    expect(tq.metrics.total_orders).toBeGreaterThanOrEqual(4);
    expect(tq.metrics.return_rate).toBeGreaterThan(0);
    expect(tq.enforcement).toBeTruthy();
    // ubah ambang: return_rate > 1% → LISTING_LIMITED, lalu recompute → status supplier berubah & tercatat di audit
    const enf = (await admin.get('/api/admin/settings')).find((s: any) => s.key === 'quality.enforcement').value;
    await admin.put('/api/admin/settings/quality.enforcement', { value: { ...enf, warning: { return_rate_gt: 0.5 }, rank_down: { return_rate_gt: 0.6 }, verification_required: { return_rate_gt: 0.7 }, listing_limited: { return_rate_gt: 0.8 }, under_review: { return_rate_gt: 200 } }, reason: 'uji enforcement' });
    const rec = await admin.post('/api/admin/quality/recompute', { supplier_id: tq.supplier_id });
    expect(rec[0].enforcement.status).toBe('LISTING_LIMITED');
    const org = (await admin.get('/api/admin/organizations?type=SUPPLIER')).find((o: any) => o.id === tq.supplier_id);
    expect(org.status).toBe('LISTING_LIMITED');
    // listing dibatasi: publish batch baru ditolak selama ada listing aktif
    const p = await tani.post('/api/supplier/products', { category_id: cat('SAYUR').id, name: 'Cabai', commodity: 'Cabai', unit: 'KG' });
    const b = await tani.post('/api/supplier/batches', { product_id: p.id, type: 'READY_STOCK', grade: 'A', quantity: 100, expected_weight_kg: 100, harvest_date: '2026-09-25', condition: 'Segar', price_per_unit: 40000, attributes: { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Merah', harvest_date: '2026-09-25', defect_tolerance_pct: 2 } });
    for (const kind of ['OVERALL', 'CLOSEUP', 'PACKAGING']) await tani.upload({ owner_type: 'BATCH', kind, batch_id: b.id });
    const r = await tani.post(`/api/supplier/batches/${b.id}/publish`, { accepted: true, declaration_version: declaration.version }, 409);
    expect(r.error).toBe('SUPPLIER_LISTING_RESTRICTED');
    // kembalikan ambang default
    await admin.put('/api/admin/settings/quality.enforcement', { value: enf, reason: 'restore' });
    const rec2 = await admin.post('/api/admin/quality/recompute', { supplier_id: tq.supplier_id });
    expect(['ACTIVE', 'WARNING', 'VERIFICATION_REQUIRED', 'LISTING_LIMITED']).toContain(rec2[0].enforcement.status);
  });
});

describe('RFQ → quotation → negosiasi → order; pembatalan; ledger global', () => {
  it('buyer RFQ → supplier quotation → buyer counter → supplier accept → order DRAFT dengan pricing engine', async () => {
    const listings = await buyer.get('/api/listings?category=TELUR');
    const batch = listings[0];
    const rfq = await buyer.post('/api/rfqs', { category_id: cat('TELUR').id, commodity: 'Telur', quantity: 500, unit: 'KG', target_price: 26000, delivery_address: 'Jl. Sudirman 1, Pekanbaru', distance_km: 120, needed_by: '2026-10-10' });
    expect(rfq.status).toBe('OPEN');
    const seen = await ternak.get('/api/rfqs');
    expect(seen.find((r: any) => r.id === rfq.id).matched).toBe(true);
    const qt = await ternak.post(`/api/rfqs/${rfq.id}/quotations`, { batch_id: batch.id, price_per_unit: 27500, quantity: 500, message: 'Harga terbaik grade A' });
    expect(qt.round).toBe(1);
    const counter = await buyer.post(`/api/quotations/${qt.id}/counter`, { price_per_unit: 26500, message: 'Volume rutin bulanan' });
    expect(counter.round).toBe(2);
    expect(counter.proposed_by).toBe('BUYER');
    await buyer.post(`/api/quotations/${counter.id}/accept`, {}, 409); // tidak boleh menerima penawaran sendiri
    const order = await ternak.post(`/api/quotations/${counter.id}/accept`, {});
    expect(order.status).toBe('DRAFT');
    expect(Number(order.unit_price)).toBe(26500);
    expect(Number(order.product_value)).toBe(500 * 26500);
    expect(Number(order.distance_km)).toBe(120);
    expect((await buyer.get(`/api/rfqs/${rfq.id}`)).status).toBe('ACCEPTED');
    // buyer konfirmasi & bayar
    const c = await buyer.post(`/api/orders/${order.id}/confirm`);
    expect(c.status).toBe('PENDING_PAYMENT');
    await buyer.post(`/api/orders/${order.id}/pay`);
    // pembatalan setelah bayar (sebelum pickup) → refund penuh kecuali payment fee, stok dikembalikan
    const cancelled = await ternak.post(`/api/orders/${order.id}/cancel`, { reason: 'Stok rusak sebelum packing' });
    expect(cancelled.status).toBe('CANCELLED');
    const d = await admin.get(`/api/orders/${order.id}`);
    expect(d.payments[0].status).toBe('REFUNDED');
    const refund = d.ledger.filter((e: any) => e.journal_type === 'REFUND_PAID' && e.account === 'CASH').reduce((a: number, e: any) => a + Number(e.amount), 0);
    const pfTax = d.pricing_snapshot.taxLines.find((t: any) => t.component === 'PAYMENT_FEE').amount;
    expect(refund).toBe(Number(order.total_amount) - Number(order.payment_fee_amount) - pfTax);
    expect((await admin.get(`/api/orders/${order.id}/reconcile`)).balanced).toBe(true);
  });

  it('21. rekonsiliasi global: Money In = Money Out + Liability + Tax + Net Revenue, semua jurnal seimbang, dashboard monetisasi konsisten', async () => {
    const rec = await admin.get('/api/admin/reconcile');
    expect(rec.balanced).toBe(true);
    expect(rec.variance).toBe(0);
    expect(rec.unbalancedJournals.length).toBe(0);
    expect(sum([rec.moneyIn, rec.receivables])).toBe(sum([rec.moneyOut, rec.liabilities, rec.tax, rec.netRevenue]));
    // Money In = total pembayaran buyer yang tercatat
    const paid = await pool.query(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')`);
    expect(rec.moneyIn).toBe(Number(paid.rows[0].v));
    const m = await admin.get('/api/admin/monetization');
    expect(m.cards.gmv).toBe(Number(paid.rows[0].v));
    expect(m.cards.platform_fee_revenue).toBeGreaterThan(0);
    expect(m.cards.average_take_rate_pct).toBeGreaterThan(0);
    expect(m.cards.net_revenue).toBe(rec.netRevenue);
    expect(m.cards.logistics_recovery).toBe(rec.receivables);
    expect(m.cards.supplier_payable).toBe(rec.balances.SUPPLIER_PAYABLE.net);
    expect(m.charts.revenue_by_category.length).toBeGreaterThan(0);
    expect(m.reconciliation.balanced).toBe(true);
    // buyer tidak boleh mengakses admin
    await buyer.get('/api/admin/monetization', 403);
  });
});

describe('Operasional komersil: ganti kata sandi & purge data uji', () => {
  it('ganti kata sandi: kata sandi lama salah ditolak, kata sandi baru dapat login', async () => {
    const u = new Api(app);
    u.token = (await u.post('/api/auth/register', { email: 'ganti@supplier.id', password: 'Lama12345', name: 'Ganti Sandi', role: 'BUYER', orgName: 'Ganti Sandi Org' }, 201)).token;
    await u.post('/api/auth/change-password', { current_password: 'salah', new_password: 'Baru12345!' }, 401);
    await u.post('/api/auth/change-password', { current_password: 'Lama12345', new_password: 'pendek' }, 400);
    const old = u.token;
    const r = await u.post('/api/auth/change-password', { current_password: 'Lama12345', new_password: 'Baru12345!' }, 200);
    await u.get('/api/auth/me', 401); // token lama dicabut
    u.token = r.token; await u.get('/api/auth/me', 200); // token baru dari respons berlaku
    await u.login('ganti@supplier.id', 'Baru12345!');
    expect(old).not.toBe(u.token);
  });

  it('purge data uji: org UJI beserta order/ledger/bukti terhapus, data lain utuh, rekonsiliasi tetap seimbang', async () => {
    const sup = new Api(app), buy = new Api(app);
    sup.token = (await sup.post('/api/auth/register', { email: 'uji-supplier-t@supplier.id', password: 'UjiProd#2026', name: 'UJI SUPPLIER', role: 'SUPPLIER', orgName: 'UJI Kelompok Tani T', supplierKind: 'KELOMPOK_TANI' }, 201)).token;
    buy.token = (await buy.post('/api/auth/register', { email: 'uji-buyer-t@supplier.id', password: 'UjiProd#2026', name: 'UJI BUYER', role: 'BUYER', orgName: 'UJI Resto T', taxStatus: 'PKP' }, 201)).token;
    const pub = await publishReadyStock(sup, { code: 'SAYUR', name: 'UJI Bayam', commodity: 'Bayam', qty: 200, price: 10000, attributes: { freshness: 'Baru panen (<24 jam)', size: 'Sedang', color: 'Hijau', harvest_date: '2026-09-27', defect_tolerance_pct: 5 } });
    const { order } = await orderToArrival(buy, sup, pub.id, 100);
    const ins = await buy.post(`/api/orders/${order.id}/inspection`, { decision: 'ACCEPT' });
    expect(ins.order.status).toBe('SETTLED');
    const before = await admin.get('/api/admin/reconcile');
    const totalBefore = await pool.query('SELECT count(*)::int AS n FROM orders');
    const preview = await admin.get('/api/admin/test-data');
    expect(preview.organizations.length).toBe(2);
    expect(preview.orders).toBe(1);
    await admin.post('/api/admin/test-data/purge', { confirm: 'salah' }, 400);
    const r = await admin.post('/api/admin/test-data/purge', { confirm: 'HAPUS DATA UJI' });
    expect(r.organizations).toBe(2);
    expect(r.orders).toBe(1);
    expect(r.evidence_files).toBe(3);
    expect(r.reconciliation.balanced).toBe(true);
    const totalAfter = await pool.query('SELECT count(*)::int AS n FROM orders');
    expect(totalAfter.rows[0].n).toBe(totalBefore.rows[0].n - 1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE 'uji-%'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM organizations WHERE name LIKE 'UJI %'`)).rows[0].n).toBe(0);
    // Money In turun tepat sebesar pembayaran order uji; sisanya tidak berubah
    const after = await admin.get('/api/admin/reconcile');
    expect(after.moneyIn).toBe(sum([before.moneyIn, -Number(order.total_amount)]));
    expect(after.unbalancedJournals.length).toBe(0);
    await sup.get('/api/auth/me', 401);
  });
});
