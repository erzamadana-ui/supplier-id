import { ensurePaymentTask } from '../services/settlement';
import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, maybe, tx } from '../db';
import { asyncH, parse, forbidden, requireRole, conflict, money, bad } from '../lib/http';
import { getSetting } from '../services/config';
import { evidenceComparison } from '../services/returns';
import { applyReturnAdjustment, Fault } from '../services/adjustment';
import { transition } from '../services/orders';
import { recomputeQualityScore } from '../services/quality';

export const returnsRouter = Router();

function guard(req: any, rc: any) {
  const u = req.user;
  if (u.role === 'BUYER' && rc.buyer_id !== u.orgId) throw forbidden();
  if (u.role === 'SUPPLIER' && rc.supplier_id !== u.orgId) throw forbidden();
}

returnsRouter.get('/returns', requireRole(), asyncH(async (req, res) => {
  const u = req.user!;
  const where = u.role === 'BUYER' ? 'rc.buyer_id=$1' : u.role === 'SUPPLIER' ? 'rc.supplier_id=$1' : '$1::text IS NOT NULL';
  res.json(await q(pool,
    `SELECT rc.*, rr.label AS reason_label, o.order_no, o.quantity AS order_quantity, o.unit, p.name AS product_name, so.name AS supplier_name, bo.name AS buyer_name,
            (SELECT status FROM disputes d WHERE d.return_case_id=rc.id) AS dispute_status
     FROM return_cases rc JOIN return_reason_codes rr ON rr.code=rc.reason_code JOIN orders o ON o.id=rc.order_id JOIN products p ON p.id=o.product_id
     JOIN organizations so ON so.id=rc.supplier_id JOIN organizations bo ON bo.id=rc.buyer_id
     WHERE ${where} ORDER BY rc.created_at DESC`, [u.role === 'ADMIN' ? 'all' : u.orgId]));
}));

returnsRouter.get('/returns/:id', requireRole(), asyncH(async (req, res) => {
  const rc = await one(pool, 'SELECT * FROM return_cases WHERE id=$1', [req.params.id]);
  guard(req, rc);
  const cmp = await evidenceComparison(pool, rc.id);
  const adjustments = await q(pool, 'SELECT * FROM financial_adjustments WHERE return_case_id=$1', [rc.id]);
  const shipment = await maybe(pool, `SELECT s.*, (SELECT json_agg(e ORDER BY e.occurred_at) FROM shipment_events e WHERE e.shipment_id=s.id) AS events FROM shipments s WHERE return_case_id=$1`, [rc.id]);
  res.json({ ...cmp, adjustments, return_shipment: shipment });
}));

/** Side-by-side SUPPLIER DECLARATION vs BUYER RECEIVING EVIDENCE (Admin). */
returnsRouter.get('/returns/:id/evidence-comparison', requireRole('ADMIN'), asyncH(async (req, res) => {
  res.json(await evidenceComparison(pool, req.params.id));
}));

/** Supplier membantah klaim → DISPUTE dibuka; buyer dapat menambah pernyataan. */
returnsRouter.post('/returns/:id/dispute', requireRole('SUPPLIER', 'BUYER'), asyncH(async (req, res) => {
  const rc = await one(pool, 'SELECT * FROM return_cases WHERE id=$1', [req.params.id]);
  guard(req, rc);
  if (!['EVIDENCE_REVIEW', 'REQUESTED'].includes(rc.status)) throw conflict('CASE_NOT_OPEN_FOR_DISPUTE', { status: rc.status });
  const { statement } = parse(z.object({ statement: z.string().min(5) }), req.body);
  const party = req.user!.role === 'SUPPLIER' ? 'SUPPLIER' : 'BUYER';
  const row = await tx(async (c) => {
    const ex = await maybe(c, 'SELECT * FROM disputes WHERE return_case_id=$1', [rc.id]);
    let d;
    if (!ex) d = await one(c, `INSERT INTO disputes(return_case_id, order_id, opened_by, status, supplier_statement, buyer_statement) VALUES ($1,$2,$3,'OPEN',$4,$5) RETURNING *`,
      [rc.id, rc.order_id, party, party === 'SUPPLIER' ? statement : null, party === 'BUYER' ? statement : null]);
    else d = await one(c, `UPDATE disputes SET ${party === 'SUPPLIER' ? 'supplier_statement' : 'buyer_statement'}=$2, status='UNDER_REVIEW' WHERE id=$1 RETURNING *`, [ex.id, statement]);
    const o = await one(c, 'SELECT status FROM orders WHERE id=$1', [rc.order_id]);
    if (['PARTIALLY_ACCEPTED', 'REJECTED'].includes(o.status)) await transition(c, rc.order_id, 'DISPUTED', req.user!.id, `Dispute dibuka oleh ${party}`);
    return d;
  });
  res.status(201).json(row);
}));

/** KEPUTUSAN ADMIN: APPROVED / PARTIAL / REJECTED + atribusi penyebab → FINANCIAL ADJUSTMENT + ledger. */
returnsRouter.post('/returns/:id/decide', requireRole('ADMIN'), asyncH(async (req, res) => {
  const rc = await one(pool, 'SELECT * FROM return_cases WHERE id=$1', [req.params.id]);
  if (!['EVIDENCE_REVIEW', 'REQUESTED', 'REJECTED'].includes(rc.status)) throw conflict('CASE_ALREADY_DECIDED', { status: rc.status });
  if (rc.decided_at) throw conflict('CASE_ALREADY_DECIDED');
  const b = parse(z.object({
    decision: z.enum(['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED']),
    approved_quantity: z.coerce.number().min(0).optional(),
    fault_attribution: z.enum(['SUPPLIER', 'PACKAGING', 'LOGISTICS', 'BUYER_RECEIVING', 'OTHER', 'UNDETERMINED']),
    notes: z.string().min(3),
    return_logistics_cost: z.coerce.number().min(0).optional(),
  }), req.body);
  const approvedQty = b.decision === 'APPROVED' ? Number(rc.quantity_affected) : b.decision === 'REJECTED' ? 0 : Number(b.approved_quantity ?? 0);
  if (b.decision === 'PARTIALLY_APPROVED' && !(approvedQty > 0 && approvedQty < Number(rc.quantity_affected))) throw bad('PARTIAL_QUANTITY_INVALID');
  const result = await tx(async (c) => {
    const o = await one(c, 'SELECT * FROM orders WHERE id=$1', [rc.order_id]);
    const ratio = Number(o.quantity) > 0 ? approvedQty / Number(o.quantity) : 0;
    const rlCost = b.decision === 'REJECTED' ? 0 : money(b.return_logistics_cost ?? Number(o.pricing_snapshot?.costBasis?.logisticsCost ?? 0) * Number(await getSetting(c, 'logistics.return_cost_ratio', 0.5)) * Math.max(ratio, 0.25));
    const upd = await one(c,
      `UPDATE return_cases SET status=$2, approved_quantity=$3, fault_attribution=$4, decision_notes=$5, decided_by=$6, decided_at=now(), return_logistics_cost=$7 WHERE id=$1 RETURNING *`,
      [rc.id, b.decision, approvedQty, b.fault_attribution, b.notes, req.user!.id, rlCost]);
    await q(c, `UPDATE disputes SET status='RESOLVED', resolution=$2::jsonb, resolved_by=$3, resolved_at=now() WHERE return_case_id=$1`,
      [rc.id, JSON.stringify({ decision: b.decision, approved_quantity: approvedQty, fault_attribution: b.fault_attribution, notes: b.notes }), req.user!.id]);
    let adjustment = null;
    if (b.decision === 'REJECTED') {
      // klaim ditolak → tidak ada refund; order selesai, supplier berhak penuh
      await transition(c, o.id, 'SETTLED', req.user!.id, 'Klaim retur ditolak; hak supplier penuh', ', settled_at=now()');
      await ensurePaymentTask(c, o.id, 'DISPUTE_RESOLVED', req.user!.id);
      await q(c, `UPDATE return_cases SET closed_at=now(), status='CLOSED' WHERE id=$1`, [rc.id]);
    } else {
      adjustment = await applyReturnAdjustment(c, o.id, rc.id, approvedQty, b.fault_attribution as Fault, req.user!.id);
    }
    return { return_case: await one(c, 'SELECT * FROM return_cases WHERE id=$1', [rc.id]), adjustment };
  });
  await recomputeQualityScore(pool, rc.supplier_id, req.user!.id);
  res.json(result);
}));

/** RETURN PICKUP → shipment tipe RETURN, LIVE TRACKING via /shipments/:id/events. */
returnsRouter.post('/returns/:id/pickup', requireRole('ADMIN', 'SUPPLIER', 'BUYER'), asyncH(async (req, res) => {
  const rc = await one(pool, 'SELECT * FROM return_cases WHERE id=$1', [req.params.id]);
  guard(req, rc);
  if (!['APPROVED', 'PARTIALLY_APPROVED'].includes(rc.status)) throw conflict('RETURN_NOT_APPROVED', { status: rc.status });
  const b = parse(z.object({ carrier: z.string().default('Supplier.id Logistics Partner'), driver_name: z.string().optional(), vehicle: z.string().optional() }), req.body ?? {});
  const row = await tx(async (c) => {
    const s = await one(c,
      `INSERT INTO shipments(order_id, return_case_id, type, status, carrier, driver_name, vehicle, tracking_no, pickup_at, logistics_cost)
       VALUES ($1,$2,'RETURN','PICKED_UP',$3,$4,$5,$6,now(),$7) RETURNING *`,
      [rc.order_id, rc.id, b.carrier, b.driver_name ?? null, b.vehicle ?? null, `RTN-${Date.now()}`, rc.return_logistics_cost]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'PICKUP','Barang retur diambil dari buyer')`, [s.id]);
    await q(c, `UPDATE return_cases SET status='PICKUP_SCHEDULED' WHERE id=$1`, [rc.id]);
    return s;
  });
  res.status(201).json(row);
}));

/** SUPPLIER RECEIVES RETURN → CASE CLOSED → order SETTLED. */
returnsRouter.post('/returns/:id/receive', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const rc = await one(pool, 'SELECT * FROM return_cases WHERE id=$1', [req.params.id]);
  guard(req, rc);
  if (!['PICKUP_SCHEDULED', 'IN_TRANSIT'].includes(rc.status)) throw conflict('RETURN_NOT_IN_TRANSIT', { status: rc.status });
  const { notes } = parse(z.object({ notes: z.string().optional() }), req.body ?? {});
  const row = await tx(async (c) => {
    await q(c, `UPDATE shipments SET status='RECEIVED', arrived_at=now() WHERE return_case_id=$1`, [rc.id]);
    const s = await one(c, 'SELECT id FROM shipments WHERE return_case_id=$1', [rc.id]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'RECEIVED',$2)`, [s.id, notes ?? 'Retur diterima supplier']);
    const upd = await one(c, `UPDATE return_cases SET status='CLOSED', received_at=now(), closed_at=now() WHERE id=$1 RETURNING *`, [rc.id]);
    const o = await one(c, 'SELECT status FROM orders WHERE id=$1', [rc.order_id]);
    if (o.status !== 'SETTLED') await transition(c, rc.order_id, 'SETTLED', req.user!.id, 'Retur selesai; order disettle', ', settled_at=now()');
    await ensurePaymentTask(c, rc.order_id, 'DISPUTE_RESOLVED', req.user!.id);
    return upd;
  });
  res.json(row);
}));
