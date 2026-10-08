import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, maybe, tx, nextNo } from '../db';
import { asyncH, parse, bad, forbidden, requireRole, conflict } from '../lib/http';
import { getSetting } from '../services/config';
import { accountBalances } from '../services/ledger';
import { latestQualityScore, recomputeQualityScore } from '../services/quality';

export const supplierRouter = Router();
supplierRouter.use(requireRole('SUPPLIER', 'ADMIN'));

const orgOf = (req: any) => (req.user.role === 'ADMIN' && req.query.supplier_id ? String(req.query.supplier_id) : req.user.orgId) as string;

// ---------------- PRODUK ----------------
const productSchema = z.object({
  category_id: z.string().uuid(),
  name: z.string().min(2),
  commodity: z.string().min(2),
  variety: z.string().optional(),
  unit: z.string().default('KG'),
  origin: z.string().optional(),
  production_method: z.string().optional(),
  certification: z.string().optional(),
});

supplierRouter.get('/products', asyncH(async (req, res) => {
  res.json(await q(pool,
    `SELECT p.*, c.code AS category_code, c.name AS category_name, c.attribute_schema,
            (SELECT COUNT(*) FROM batches b WHERE b.product_id=p.id)::int AS batch_count
     FROM products p JOIN categories c ON c.id=p.category_id WHERE p.supplier_id=$1 ORDER BY p.created_at DESC`, [orgOf(req)]));
}));

supplierRouter.post('/products', asyncH(async (req, res) => {
  const b = parse(productSchema, req.body);
  const row = await one(pool,
    `INSERT INTO products(supplier_id, category_id, name, commodity, variety, unit, origin, production_method, certification, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_DECLARATION') RETURNING *`,
    [orgOf(req), b.category_id, b.name, b.commodity, b.variety ?? null, b.unit, b.origin ?? null, b.production_method ?? null, b.certification ?? null]);
  res.status(201).json(row);
}));

// ---------------- BATCH (READY STOCK / HARVEST) ----------------
const batchSchema = z.object({
  product_id: z.string().uuid(),
  type: z.enum(['READY_STOCK', 'HARVEST']),
  grade: z.string().optional(),
  quantity: z.coerce.number().positive(),
  unit: z.string().default('KG'),
  expected_weight_kg: z.coerce.number().positive().optional(),
  weight_tolerance_pct: z.coerce.number().min(0).max(50).optional(),
  harvest_date: z.string().optional(),
  availability_date: z.string().optional(),
  condition: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  freshness: z.string().optional(),
  moisture: z.string().optional(),
  temperature_c: z.coerce.number().optional(),
  shelf_life_days: z.coerce.number().int().optional(),
  expiry_date: z.string().optional(),
  attributes: z.record(z.string(), z.any()).default({}),
  price_per_unit: z.coerce.number().positive(),
  min_order_qty: z.coerce.number().positive().optional(),
  sale_mode: z.enum(['READY', 'PREORDER']).optional(),
  lead_time_days: z.coerce.number().int().min(0).optional(),
  cutoff_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  lot_code: z.string().optional(),
  // untuk HARVEST
  harvest: z.object({
    planting_date: z.string().optional(),
    expected_harvest_date: z.string(),
    expected_quantity: z.coerce.number().positive(),
    expected_grade: z.string().optional(),
    expected_quality: z.string().optional(),
    current_condition: z.string().optional(),
    forecast_confidence: z.coerce.number().int().min(0).max(100).optional(),
  }).optional(),
});

supplierRouter.get('/batches', asyncH(async (req, res) => {
  res.json(await q(pool,
    `SELECT b.*, p.name AS product_name, p.commodity, c.code AS category_code, hv.stage AS harvest_stage, hv.expected_harvest_date,
            (SELECT COUNT(*) FROM evidence_files e WHERE e.batch_id=b.id)::int AS photo_count
     FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id LEFT JOIN harvests hv ON hv.batch_id=b.id
     WHERE b.supplier_id=$1 ORDER BY b.created_at DESC`, [orgOf(req)]));
}));

supplierRouter.get('/batches/:id', asyncH(async (req, res) => {
  const b = await one(pool, `SELECT b.*, p.name AS product_name, p.category_id, c.attribute_schema, c.code AS category_code, c.min_photos FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id WHERE b.id=$1`, [req.params.id]);
  if (req.user!.role !== 'ADMIN' && b.supplier_id !== req.user!.orgId) throw forbidden();
  const photos = await q(pool, 'SELECT * FROM evidence_files WHERE batch_id=$1 ORDER BY uploaded_at', [b.id]);
  const harvest = await maybe(pool, 'SELECT * FROM harvests WHERE batch_id=$1', [b.id]);
  const acceptance = await maybe(pool, 'SELECT * FROM declaration_acceptances WHERE batch_id=$1 ORDER BY accepted_at DESC LIMIT 1', [b.id]);
  res.json({ ...b, photos, harvest, acceptance, readiness: await readiness(b) });
}));


/** Kolom batch yang sering sama dengan kunci atribut kategori; atribut yang kosong diisi otomatis dari kolom agar supplier tidak mengisi dua kali. */
const MIRROR_COLUMNS = ['grade', 'condition', 'size', 'color', 'freshness', 'moisture', 'temperature_c', 'harvest_date', 'availability_date', 'expiry_date', 'shelf_life_days', 'expected_weight_kg'];
export function mergeMirroredAttributes(fields: Record<string, any>, attributes: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = { ...(attributes ?? {}) };
  for (const k of MIRROR_COLUMNS) {
    if ((out[k] === undefined || out[k] === '') && fields[k] !== undefined && fields[k] !== null && fields[k] !== '') out[k] = fields[k];
  }
  return out;
}

supplierRouter.post('/batches', asyncH(async (req, res) => {
  const b = parse(batchSchema, req.body);
  b.attributes = mergeMirroredAttributes(b, b.attributes);
  const p = await one(pool, 'SELECT * FROM products WHERE id=$1', [b.product_id]);
  if (p.supplier_id !== orgOf(req)) throw forbidden();
  if (b.type === 'HARVEST' && !b.harvest) throw bad('HARVEST_DETAILS_REQUIRED');
  const row = await tx(async (c) => {
    const code = await nextNo(c, 'batch', 'BATCH');
    const batch = await one(c,
      `INSERT INTO batches(product_id, supplier_id, type, status, batch_code, grade, quantity, available_quantity, unit, expected_weight_kg, weight_tolerance_pct,
         harvest_date, availability_date, condition, size, color, freshness, moisture, temperature_c, shelf_life_days, expiry_date, attributes, price_per_unit,
         min_order_qty, sale_mode, lead_time_days, cutoff_time, lot_code)
       VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$6,$7,$8,COALESCE($9,2.0),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,COALESCE($22,1),COALESCE($23,'READY'),COALESCE($24,1),$25,$26) RETURNING *`,
      [b.product_id, p.supplier_id, b.type, code, b.grade ?? null, b.quantity, b.unit, b.expected_weight_kg ?? null, b.weight_tolerance_pct ?? null,
        b.harvest_date ?? null, b.availability_date ?? null, b.condition ?? null, b.size ?? null, b.color ?? null, b.freshness ?? null, b.moisture ?? null,
        b.temperature_c ?? null, b.shelf_life_days ?? null, b.expiry_date ?? null, JSON.stringify(b.attributes), b.price_per_unit,
        b.min_order_qty ?? null, b.type === 'HARVEST' ? 'PREORDER' : b.sale_mode ?? null, b.lead_time_days ?? null, b.cutoff_time ?? null, b.lot_code ?? null]);
    if (b.type === 'HARVEST' && b.harvest) {
      const h = b.harvest;
      await q(c,
        `INSERT INTO harvests(batch_id, planting_date, expected_harvest_date, expected_quantity, expected_grade, expected_quality, current_condition, forecast_confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batch.id, h.planting_date ?? null, h.expected_harvest_date, h.expected_quantity, h.expected_grade ?? null, h.expected_quality ?? null, h.current_condition ?? null, h.forecast_confidence ?? null]);
    }
    return batch;
  });
  res.status(201).json(row);
}));

supplierRouter.patch('/batches/:id', asyncH(async (req, res) => {
  const cur = await one(pool, 'SELECT * FROM batches WHERE id=$1', [req.params.id]);
  if (cur.supplier_id !== orgOf(req)) throw forbidden();
  const b = parse(batchSchema.partial().omit({ product_id: true, type: true }), req.body);
  if (b.attributes !== undefined || MIRROR_COLUMNS.some((k) => (b as any)[k] !== undefined)) b.attributes = mergeMirroredAttributes({ ...cur, ...b }, b.attributes ?? cur.attributes);
  const cols: string[] = []; const vals: any[] = [cur.id];
  for (const [k, v] of Object.entries(b)) {
    if (k === 'harvest' || v === undefined) continue;
    vals.push(k === 'attributes' ? JSON.stringify(v) : v);
    cols.push(`${k}=$${vals.length}${k === 'attributes' ? '::jsonb' : ''}`);
  }
  if (b.quantity != null && cur.status === 'DRAFT') { vals.push(b.quantity); cols.push(`available_quantity=$${vals.length}`); }
  if (!cols.length) return res.json(cur);
  res.json(await one(pool, `UPDATE batches SET ${cols.join(',')} WHERE id=$1 RETURNING *`, vals));
}));

/** Cek kesiapan publikasi: field wajib, atribut dinamis kategori, minimum foto & jenis foto. */
async function readiness(b: any) {
  const categoryId = b.category_id ?? (await one(pool, 'SELECT category_id FROM products WHERE id=$1', [b.product_id])).category_id;
  const cat = await one(pool, 'SELECT * FROM categories WHERE id=$1', [categoryId]);
  const minPhotos = cat.min_photos ?? Number(await getSetting(pool, 'evidence.min_photos', 3));
  const requiredKinds: string[] = await getSetting(pool, 'evidence.required_kinds', ['OVERALL', 'CLOSEUP', 'PACKAGING']);
  const photos = await q(pool, `SELECT kind FROM evidence_files WHERE batch_id=$1 AND owner_type IN ('BATCH','HARVEST_CURRENT')`, [b.id]);
  const missing: string[] = [];
  const isHarvest = b.type === 'HARVEST';
  if (!b.grade && !isHarvest) missing.push('grade');
  if (!(Number(b.quantity) > 0)) missing.push('quantity');
  if (!b.condition && !isHarvest) missing.push('condition');
  if (!isHarvest && !b.harvest_date && !b.availability_date) missing.push('harvest_date|availability_date');
  if (!(Number(b.price_per_unit) > 0)) missing.push('price_per_unit');
  for (const f of cat.attribute_schema as any[]) {
    const av = b.attributes?.[f.key] ?? (MIRROR_COLUMNS.includes(f.key) ? b[f.key] : undefined);
    if (f.required && !isHarvest && (av === undefined || av === null || av === '')) missing.push(`attributes.${f.key}`);
  }
  const kinds = new Set(photos.map((p) => p.kind));
  const missingKinds = isHarvest ? (kinds.has('CURRENT') || kinds.has('OVERALL') ? [] : ['CURRENT']) : requiredKinds.filter((k) => !kinds.has(k));
  const photoOk = photos.length >= (isHarvest ? 1 : minPhotos) && missingKinds.length === 0;
  return { ok: missing.length === 0 && photoOk, missing_fields: missing, photos: photos.length, min_photos: isHarvest ? 1 : minPhotos, final_min_photos: minPhotos, missing_photo_kinds: missingKinds };
}

/**
 * DEKLARASI & PUBLIKASI: supplier menyetujui Quality Self Declaration & Return Guarantee.
 * Menyimpan acceptance (supplier_id, version, accepted_at, IP/UA, product_id, batch_id, snapshot data).
 */
supplierRouter.post('/batches/:id/publish', asyncH(async (req, res) => {
  const b = await one(pool, `SELECT b.*, p.category_id FROM batches b JOIN products p ON p.id=b.product_id WHERE b.id=$1`, [req.params.id]);
  if (b.supplier_id !== orgOf(req)) throw forbidden();
  const org = await one(pool, 'SELECT status, verified FROM organizations WHERE id=$1', [b.supplier_id]);
  if (!org.verified && (await getSetting(pool, 'supplier.require_verified_to_publish', false))) throw conflict('SUPPLIER_NOT_VERIFIED', { hint: 'Menunggu verifikasi admin sebelum listing dapat ditayangkan' });
  if (['SUSPENDED', 'UNDER_REVIEW', 'LISTING_LIMITED'].includes(org.status)) {
    const activeCount = await one(pool, `SELECT COUNT(*)::int AS n FROM batches WHERE supplier_id=$1 AND status IN ('READY_FOR_ORDER','UPCOMING','PRE_HARVEST_UPDATED')`, [b.supplier_id]);
    if (org.status !== 'LISTING_LIMITED' || activeCount.n >= 1) throw conflict('SUPPLIER_LISTING_RESTRICTED', { status: org.status });
  }
  const { accepted, declaration_version } = parse(z.object({ accepted: z.literal(true), declaration_version: z.coerce.number().int() }), req.body);
  const ver = await one(pool, 'SELECT * FROM declaration_versions WHERE version=$1 AND active', [declaration_version]);
  const ready = await readiness(b);
  if (!ready.ok) throw bad('DECLARATION_INCOMPLETE', ready);
  const result = await tx(async (c) => {
    await q(c,
      `INSERT INTO declaration_acceptances(supplier_id, user_id, declaration_version, product_id, batch_id, ip_address, user_agent, declared_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [b.supplier_id, req.user!.id, ver.version, b.product_id, b.id, req.ip, req.headers['user-agent'] ?? null, JSON.stringify(b)]);
    const newStatus = b.type === 'HARVEST' ? 'UPCOMING' : 'READY_FOR_ORDER';
    const batch = await one(c, `UPDATE batches SET status=$2, declaration_accepted_at=now(), published_at=now() WHERE id=$1 RETURNING *`, [b.id, newStatus]);
    await q(c, `UPDATE products SET status=$2 WHERE id=$1`, [b.product_id, b.type === 'HARVEST' ? 'UPCOMING_HARVEST' : 'ACTIVE']);
    return batch;
  });
  void accepted;
  res.json(result);
}));

// ---------------- HARVEST LIFECYCLE ----------------
/** PRE-HARVEST QUALITY UPDATE: foto terbaru + kondisi terkini menjelang panen. */
supplierRouter.post('/batches/:id/harvest/pre-update', asyncH(async (req, res) => {
  const b = await one(pool, 'SELECT * FROM batches WHERE id=$1', [req.params.id]);
  if (b.supplier_id !== orgOf(req)) throw forbidden();
  if (b.type !== 'HARVEST' || !['UPCOMING', 'PRE_HARVEST_UPDATED'].includes(b.status)) throw conflict('NOT_UPCOMING_HARVEST');
  const d = parse(z.object({ current_condition: z.string(), forecast_confidence: z.coerce.number().int().min(0).max(100).optional(), expected_quantity: z.coerce.number().positive().optional(), expected_harvest_date: z.string().optional(), note: z.string().optional() }), req.body);
  const photos = await one(pool, `SELECT COUNT(*)::int AS n FROM evidence_files WHERE batch_id=$1 AND owner_type='HARVEST_PRE'`, [b.id]);
  if (photos.n < 1) throw bad('PRE_HARVEST_PHOTO_REQUIRED');
  const h = await one(pool,
    `UPDATE harvests SET stage='PRE_HARVEST_UPDATED', current_condition=$2, forecast_confidence=COALESCE($3,forecast_confidence),
       expected_quantity=COALESCE($4,expected_quantity), expected_harvest_date=COALESCE($5,expected_harvest_date), pre_harvest_note=$6, pre_harvest_updated_at=now()
     WHERE batch_id=$1 RETURNING *`, [b.id, d.current_condition, d.forecast_confidence ?? null, d.expected_quantity ?? null, d.expected_harvest_date ?? null, d.note ?? null]);
  await q(pool, `UPDATE batches SET status='PRE_HARVEST_UPDATED' WHERE id=$1`, [b.id]);
  res.json(h);
}));

/** FINAL HARVEST DECLARATION → READY FOR ORDER. */
supplierRouter.post('/batches/:id/harvest/finalize', asyncH(async (req, res) => {
  const b = await one(pool, 'SELECT * FROM batches WHERE id=$1', [req.params.id]);
  if (b.supplier_id !== orgOf(req)) throw forbidden();
  if (b.type !== 'HARVEST' || !['UPCOMING', 'PRE_HARVEST_UPDATED'].includes(b.status)) throw conflict('NOT_UPCOMING_HARVEST');
  const d = parse(z.object({
    actual_quantity: z.coerce.number().positive(), actual_grade: z.string(), actual_weight_kg: z.coerce.number().positive().optional(),
    actual_condition: z.string(), actual_harvest_date: z.string(), attributes: z.record(z.string(), z.any()).optional(), price_per_unit: z.coerce.number().positive().optional(),
    accepted: z.literal(true), declaration_version: z.coerce.number().int(),
  }), req.body);
  const finals = await one(pool, `SELECT COUNT(*)::int AS n FROM evidence_files WHERE batch_id=$1 AND owner_type='HARVEST_FINAL'`, [b.id]);
  const minPhotos = Number(await getSetting(pool, 'evidence.min_photos', 3));
  if (finals.n < minPhotos) throw bad('FINAL_PHOTOS_REQUIRED', { required: minPhotos, uploaded: finals.n });
  const ver = await one(pool, 'SELECT * FROM declaration_versions WHERE version=$1 AND active', [d.declaration_version]);
  // atribut kategori yang cermin kolom batch diisi dari data final (grade/kondisi/tanggal panen/berat)
  const mergedAttrs = mergeMirroredAttributes(
    { ...b, grade: d.actual_grade, condition: d.actual_condition, harvest_date: d.actual_harvest_date, expected_weight_kg: d.actual_weight_kg ?? b.expected_weight_kg },
    { ...(b.attributes ?? {}), ...(d.attributes ?? {}) });
  const result = await tx(async (c) => {
    await q(c,
      `UPDATE harvests SET stage='FINAL', actual_quantity=$2, actual_grade=$3, actual_weight_kg=$4, actual_condition=$5, actual_harvest_date=$6, finalized_at=now() WHERE batch_id=$1`,
      [b.id, d.actual_quantity, d.actual_grade, d.actual_weight_kg ?? null, d.actual_condition, d.actual_harvest_date]);
    const batch = await one(c,
      `UPDATE batches SET status='READY_FOR_ORDER', quantity=$2, available_quantity=$2, grade=$3, expected_weight_kg=COALESCE($4,expected_weight_kg), condition=$5,
         harvest_date=$6, attributes=COALESCE($7::jsonb, attributes), price_per_unit=COALESCE($8, price_per_unit), declaration_accepted_at=now() WHERE id=$1 RETURNING *`,
      [b.id, d.actual_quantity, d.actual_grade, d.actual_weight_kg ?? null, d.actual_condition, d.actual_harvest_date, JSON.stringify(mergedAttrs), d.price_per_unit ?? null]);
    await q(c,
      `INSERT INTO declaration_acceptances(supplier_id, user_id, declaration_version, product_id, batch_id, ip_address, user_agent, declared_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [b.supplier_id, req.user!.id, ver.version, b.product_id, b.id, req.ip, req.headers['user-agent'] ?? null, JSON.stringify({ ...batch, final_declaration: d })]);
    await q(c, `UPDATE products SET status='ACTIVE' WHERE id=$1`, [b.product_id]);
    return batch;
  });
  await recomputeQualityScore(pool, b.supplier_id);
  res.json(result);
}));

/** Daftar panen yang perlu PRE-HARVEST UPDATE (H-n) — dipakai notifikasi/dashboard. */
supplierRouter.get('/harvest/reminders', asyncH(async (req, res) => {
  const days = Number(await getSetting(pool, 'harvest.pre_harvest_reminder_days', 7));
  res.json(await q(pool,
    `SELECT b.id AS batch_id, b.batch_code, p.name AS product_name, hv.* FROM harvests hv JOIN batches b ON b.id=hv.batch_id JOIN products p ON p.id=b.product_id
     WHERE b.supplier_id=$1 AND hv.stage='UPCOMING' AND hv.expected_harvest_date <= CURRENT_DATE + ($2::int) ORDER BY hv.expected_harvest_date`, [orgOf(req), days]));
}));

// ---------------- SUPPLIER DASHBOARD: PAYOUT ----------------
supplierRouter.get('/dashboard', asyncH(async (req, res) => {
  const sid = orgOf(req);
  const bal = await accountBalances(pool, { partyId: sid });
  const orders = await q(pool,
    `SELECT o.id, o.order_no, o.status, o.quantity, o.accepted_quantity, o.rejected_quantity, o.product_value, o.settled_at, o.created_at, p.name AS product_name,
            bo.name AS buyer_name,
            COALESCE((SELECT SUM(CASE WHEN e.side='CREDIT' THEN e.amount ELSE -e.amount END) FROM ledger_entries e WHERE e.order_id=o.id AND e.account='SUPPLIER_PAYABLE' AND e.party_id=o.supplier_id AND e.component<>'SUPPLIER_PAYOUT'),0) AS supplier_receivable,
            COALESCE((SELECT SUM(e.amount) FROM ledger_entries e WHERE e.order_id=o.id AND e.account='SUPPLIER_PAYABLE' AND e.side='DEBIT' AND e.component='RETURN_ADJUSTMENT'),0) AS return_deduction,
            COALESCE((SELECT SUM(e.amount) FROM ledger_entries e WHERE e.order_id=o.id AND e.account='SUPPLIER_PAYABLE' AND e.side='DEBIT' AND e.component='SUPPLIER_PAYOUT'),0) AS paid
     FROM orders o JOIN products p ON p.id=o.product_id JOIN organizations bo ON bo.id=o.buyer_id
     WHERE o.supplier_id=$1 AND o.status<>'DRAFT' ORDER BY o.created_at DESC`, [sid]);
  const payouts = await q(pool, 'SELECT * FROM payouts WHERE supplier_id=$1 ORDER BY created_at DESC', [sid]);
  const sp = bal.SUPPLIER_PAYABLE ?? { debit: 0, credit: 0, net: 0 };
  const paidTotal = payouts.filter((p) => p.status === 'PAID').reduce((a, p) => a + Number(p.amount), 0);
  const productValue = orders.reduce((a, o) => a + Number(o.product_value), 0);
  const adjustments = orders.reduce((a, o) => a + Number(o.return_deduction), 0);
  res.json({
    summary: {
      product_value: productValue,
      adjustment: adjustments,
      supplier_receivable: sp.net + paidTotal, // hak bersih total (sudah termasuk yang telah dibayar)
      paid: paidTotal,
      pending: sp.net,                          // belum dibayar
    },
    orders, payouts, quality: await latestQualityScore(pool, sid),
    organization: await one(pool, 'SELECT * FROM organizations WHERE id=$1', [sid]),
  });
}));
