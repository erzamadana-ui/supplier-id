import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx, nextNo } from '../db';
import { asyncH, parse, bad, forbidden, requireRole, conflict } from '../lib/http';
import { createDraftOrder } from './orders';

export const rfqRouter = Router();

const rfqSchema = z.object({
  category_id: z.string().uuid().optional(),
  batch_id: z.string().uuid().optional(),
  commodity: z.string().min(2),
  quantity: z.coerce.number().positive(),
  unit: z.string().default('KG'),
  target_price: z.coerce.number().positive().optional(),
  required_grade: z.string().optional(),
  delivery_address: z.string().optional(),
  delivery_region: z.string().optional(),
  distance_km: z.coerce.number().min(0).default(0),
  needed_by: z.string().optional(),
});

rfqRouter.post('/rfqs', requireRole('BUYER'), asyncH(async (req, res) => {
  const b = parse(rfqSchema, req.body);
  const row = await tx(async (c) => one(c,
    `INSERT INTO rfqs(rfq_no, buyer_id, category_id, batch_id, commodity, quantity, unit, target_price, required_grade, delivery_address, delivery_region, distance_km, needed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [await nextNo(c, 'rfq', 'RFQ'), req.user!.orgId, b.category_id ?? null, b.batch_id ?? null, b.commodity, b.quantity, b.unit, b.target_price ?? null,
      b.required_grade ?? null, b.delivery_address ?? null, b.delivery_region ?? null, b.distance_km, b.needed_by ?? null]));
  res.status(201).json(row);
}));

/** MATCHING: supplier melihat RFQ terbuka yang cocok dengan komoditas/kategori listing aktifnya. */
rfqRouter.get('/rfqs', requireRole(), asyncH(async (req, res) => {
  const u = req.user!;
  let rows;
  if (u.role === 'BUYER') rows = await q(pool, `SELECT r.*, (SELECT COUNT(*) FROM quotations x WHERE x.rfq_id=r.id)::int AS quote_count FROM rfqs r WHERE buyer_id=$1 ORDER BY created_at DESC`, [u.orgId]);
  else if (u.role === 'SUPPLIER') rows = await q(pool,
    `SELECT r.*, bo.name AS buyer_name, bo.region AS buyer_region,
            (SELECT COUNT(*) FROM quotations x WHERE x.rfq_id=r.id AND x.supplier_id=$1)::int AS my_quotes,
            EXISTS (SELECT 1 FROM batches b JOIN products p ON p.id=b.product_id WHERE b.supplier_id=$1 AND b.status IN ('READY_FOR_ORDER','UPCOMING','PRE_HARVEST_UPDATED')
                    AND (p.commodity ILIKE '%'||r.commodity||'%' OR r.category_id=p.category_id OR r.batch_id=b.id)) AS matched
     FROM rfqs r JOIN organizations bo ON bo.id=r.buyer_id
     WHERE r.status IN ('OPEN','QUOTED') OR EXISTS (SELECT 1 FROM quotations x WHERE x.rfq_id=r.id AND x.supplier_id=$1)
     ORDER BY matched DESC, r.created_at DESC`, [u.orgId]);
  else rows = await q(pool, `SELECT r.*, bo.name AS buyer_name FROM rfqs r JOIN organizations bo ON bo.id=r.buyer_id ORDER BY created_at DESC`);
  res.json(rows);
}));

rfqRouter.get('/rfqs/:id', requireRole(), asyncH(async (req, res) => {
  const r = await one(pool, `SELECT r.*, bo.name AS buyer_name FROM rfqs r JOIN organizations bo ON bo.id=r.buyer_id WHERE r.id=$1`, [req.params.id]);
  const quotes = await q(pool,
    `SELECT qt.*, so.name AS supplier_name, b.batch_code, p.name AS product_name, b.grade, b.status AS batch_status
     FROM quotations qt JOIN organizations so ON so.id=qt.supplier_id JOIN batches b ON b.id=qt.batch_id JOIN products p ON p.id=b.product_id
     WHERE qt.rfq_id=$1 ORDER BY qt.created_at`, [r.id]);
  res.json({ ...r, quotations: req.user!.role === 'SUPPLIER' ? quotes.filter((x) => x.supplier_id === req.user!.orgId) : quotes });
}));

/** QUOTATION oleh supplier untuk RFQ. */
rfqRouter.post('/rfqs/:id/quotations', requireRole('SUPPLIER'), asyncH(async (req, res) => {
  const r = await one(pool, 'SELECT * FROM rfqs WHERE id=$1', [req.params.id]);
  if (!['OPEN', 'QUOTED'].includes(r.status)) throw conflict('RFQ_CLOSED');
  const b = parse(z.object({ batch_id: z.string().uuid(), price_per_unit: z.coerce.number().positive(), quantity: z.coerce.number().positive(), message: z.string().optional(), valid_until: z.string().optional() }), req.body);
  const batch = await one(pool, 'SELECT * FROM batches WHERE id=$1', [b.batch_id]);
  if (batch.supplier_id !== req.user!.orgId) throw forbidden();
  if (!['READY_FOR_ORDER', 'UPCOMING', 'PRE_HARVEST_UPDATED'].includes(batch.status)) throw conflict('BATCH_NOT_LISTED');
  const org = await one(pool, 'SELECT status FROM organizations WHERE id=$1', [batch.supplier_id]);
  if (['SUSPENDED', 'UNDER_REVIEW'].includes(org.status)) throw conflict('SUPPLIER_RESTRICTED');
  const row = await one(pool,
    `INSERT INTO quotations(rfq_id, supplier_id, batch_id, proposed_by, round, price_per_unit, quantity, message, valid_until)
     VALUES ($1,$2,$3,'SUPPLIER',1,$4,$5,$6,$7) RETURNING *`,
    [r.id, batch.supplier_id, batch.id, b.price_per_unit, b.quantity, b.message ?? null, b.valid_until ?? null]);
  await q(pool, `UPDATE rfqs SET status='QUOTED' WHERE id=$1 AND status='OPEN'`, [r.id]);
  res.status(201).json(row);
}));

/** NEGOSIASI: counter-offer oleh buyer atau supplier. */
rfqRouter.post('/quotations/:id/counter', requireRole('BUYER', 'SUPPLIER'), asyncH(async (req, res) => {
  const parent = await one(pool, 'SELECT qt.*, r.buyer_id FROM quotations qt JOIN rfqs r ON r.id=qt.rfq_id WHERE qt.id=$1', [req.params.id]);
  const u = req.user!;
  const party = u.role === 'BUYER' ? 'BUYER' : 'SUPPLIER';
  if (party === 'BUYER' && parent.buyer_id !== u.orgId) throw forbidden();
  if (party === 'SUPPLIER' && parent.supplier_id !== u.orgId) throw forbidden();
  if (parent.status !== 'PENDING') throw conflict('QUOTE_NOT_PENDING');
  if (parent.proposed_by === party) throw conflict('WAIT_FOR_COUNTERPARTY');
  const b = parse(z.object({ price_per_unit: z.coerce.number().positive(), quantity: z.coerce.number().positive().optional(), message: z.string().optional() }), req.body);
  const row = await tx(async (c) => {
    await q(c, `UPDATE quotations SET status='COUNTERED' WHERE id=$1`, [parent.id]);
    return one(c,
      `INSERT INTO quotations(rfq_id, supplier_id, batch_id, parent_id, proposed_by, round, price_per_unit, quantity, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [parent.rfq_id, parent.supplier_id, parent.batch_id, parent.id, party, parent.round + 1, b.price_per_unit, b.quantity ?? parent.quantity, b.message ?? null]);
  });
  res.status(201).json(row);
}));

/** ACCEPT: pihak lawan menerima penawaran terakhir → FINAL PRODUCT PRICE → order DRAFT dengan pricing engine. */
rfqRouter.post('/quotations/:id/accept', requireRole('BUYER', 'SUPPLIER'), asyncH(async (req, res) => {
  const qt = await one(pool, 'SELECT qt.*, r.buyer_id, r.distance_km, r.delivery_address FROM quotations qt JOIN rfqs r ON r.id=qt.rfq_id WHERE qt.id=$1', [req.params.id]);
  const u = req.user!;
  const party = u.role === 'BUYER' ? 'BUYER' : 'SUPPLIER';
  if (party === 'BUYER' && qt.buyer_id !== u.orgId) throw forbidden();
  if (party === 'SUPPLIER' && qt.supplier_id !== u.orgId) throw forbidden();
  if (qt.status !== 'PENDING') throw conflict('QUOTE_NOT_PENDING');
  if (qt.proposed_by === party) throw conflict('CANNOT_ACCEPT_OWN_OFFER');
  const b = parse(z.object({ optional_service_codes: z.array(z.string()).default([]), promo_code: z.string().optional(), distance_km: z.coerce.number().min(0).optional() }), req.body ?? {});
  const order = await tx(async (c) => {
    await q(c, `UPDATE quotations SET status='ACCEPTED' WHERE id=$1`, [qt.id]);
    await q(c, `UPDATE quotations SET status='REJECTED' WHERE rfq_id=$1 AND id<>$2 AND status='PENDING'`, [qt.rfq_id, qt.id]);
    await q(c, `UPDATE rfqs SET status='ACCEPTED' WHERE id=$1`, [qt.rfq_id]);
    return createDraftOrder(c, {
      buyerId: qt.buyer_id, batchId: qt.batch_id, quantity: Number(qt.quantity), unitPrice: Number(qt.price_per_unit),
      distanceKm: b.distance_km ?? Number(qt.distance_km), deliveryAddress: qt.delivery_address, optionalServiceCodes: b.optional_service_codes,
      promoCode: b.promo_code ?? null, rfqId: qt.rfq_id, quotationId: qt.id,
    });
  });
  res.status(201).json(order);
}));
