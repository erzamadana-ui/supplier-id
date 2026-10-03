/** Task inbox mitra, QC, paket & label, scan, keputusan selisih berat pelanggan. */
import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { asyncH, parse, forbidden, requireRole, requirePerm } from '../lib/http';
import { acceptOrder, rejectOrder, startTask, completeWorkTask, recordQc, createPackage, recordLabelPrint, cancelPackage, completePacking, scanPackage, decideWeightVariance } from '../services/fulfillment';

export const fulfillmentRouter = Router();

const TASK_SELECT = `SELECT t.*, o.order_no, o.status AS order_status, o.promised_pickup_at, o.delivery_address, o.weight_adjustment, p.name AS product_name, b.batch_code, bo.name AS buyer_name,
    (now() > t.deadline AND t.status NOT IN ('DONE','REJECTED','CANCELLED')) AS overdue
  FROM fulfillment_tasks t JOIN orders o ON o.id=t.order_id JOIN products p ON p.id=o.product_id JOIN batches b ON b.id=o.batch_id JOIN organizations bo ON bo.id=o.buyer_id`;

/** Inbox: baru / menunggu respons / dikerjakan / perlu tindakan / terlambat / selesai / ditolak. */
fulfillmentRouter.get('/tasks', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const u = req.user!;
  const { status, stage, supplier_id } = req.query as Record<string, string>;
  const params: any[] = []; const where: string[] = [];
  if (u.role === 'SUPPLIER') { params.push(u.orgId); where.push(`t.supplier_id=$${params.length}`); }
  else if (supplier_id) { params.push(supplier_id); where.push(`t.supplier_id=$${params.length}`); }
  if (status) { params.push(status.split(',')); where.push(`t.status = ANY($${params.length})`); }
  if (stage) { params.push(stage); where.push(`t.stage=$${params.length}`); }
  const rows = await q(pool, `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.priority, t.deadline NULLS LAST, t.created_at DESC LIMIT 500`, params);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  res.json({ tasks: rows, counts });
}));

fulfillmentRouter.get('/tasks/:id', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const t = await one(pool, `${TASK_SELECT} WHERE t.id=$1`, [req.params.id]);
  if (req.user!.role === 'SUPPLIER' && t.supplier_id !== req.user!.orgId) throw forbidden();
  const [events, qc, packages, evidence, deps] = await Promise.all([
    q(pool, 'SELECT e.*, u.name AS actor_name FROM task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE task_id=$1 ORDER BY created_at', [t.id]),
    q(pool, 'SELECT * FROM qc_records WHERE order_id=$1 ORDER BY created_at DESC', [t.order_id]),
    q(pool, `SELECT p.*, (SELECT COUNT(*) FROM label_prints l WHERE l.package_id=p.id)::int AS prints FROM packages p WHERE order_id=$1 ORDER BY created_at`, [t.order_id]),
    q(pool, `SELECT * FROM evidence_files WHERE order_id=$1 AND owner_type IN ('QC','PACKAGE') ORDER BY uploaded_at`, [t.order_id]),
    q(pool, 'SELECT id, task_no, stage, status, done_at FROM fulfillment_tasks WHERE order_id=$1 ORDER BY created_at', [t.order_id]),
  ]);
  res.json({ ...t, events, qc_records: qc, packages, evidence, pipeline: deps });
}));

fulfillmentRouter.post('/tasks/:id/accept', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ ready_at: z.string().optional(), note: z.string().optional() }), req.body ?? {});
  res.json(await tx((c) => acceptOrder(c, req.params.id, req.user!, b)));
}));
fulfillmentRouter.post('/tasks/:id/reject', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  res.json(await tx((c) => rejectOrder(c, req.params.id, req.user!, b.reason)));
}));
fulfillmentRouter.post('/tasks/:id/start', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => res.json(await tx((c) => startTask(c, req.params.id, req.user!)))));
fulfillmentRouter.post('/tasks/:id/complete', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ result: z.record(z.string(), z.any()).optional() }), req.body ?? {});
  res.json(await tx((c) => completeWorkTask(c, req.params.id, req.user!, b.result ?? {})));
}));
fulfillmentRouter.post('/tasks/:id/qc', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({
    measured_quantity: z.coerce.number().positive().optional(), measured_weight_kg: z.coerce.number().positive().optional(), measured_temperature_c: z.coerce.number().optional(),
    grade: z.string().optional(), passed: z.coerce.boolean(), reject_reason: z.string().optional(), notes: z.string().optional(),
  }), req.body);
  res.json(await tx((c) => recordQc(c, req.params.id, req.user!, b)));
}));
fulfillmentRouter.post('/tasks/:id/packages', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ quantity: z.coerce.number().positive(), weight_kg: z.coerce.number().positive().optional(), storage_instructions: z.string().optional(), shelf_life_days: z.coerce.number().int().positive().optional(), expiry_date: z.string().optional() }), req.body);
  res.status(201).json(await tx((c) => createPackage(c, req.params.id, req.user!, b)));
}));
fulfillmentRouter.post('/tasks/:id/complete-packing', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => res.json(await tx((c) => completePacking(c, req.params.id, req.user!)))));

/** Data label (untuk render PDF A4/thermal di klien); setiap render tercatat sebagai cetak/reprint. */
fulfillmentRouter.get('/packages/:id/label', requireRole('SUPPLIER', 'ADMIN', 'COURIER'), asyncH(async (req, res) => {
  const p = await one(pool, `SELECT p.*, o.order_no, o.order_group_id, o.delivery_address, o.quantity AS order_quantity, pr.name AS product_name, pr.commodity, b.batch_code, b.grade, b.harvest_date, b.lot_code,
      s.name AS supplier_name, s.region AS supplier_region, bo.name AS buyer_name, g.group_no, c.name AS category_name,
      (SELECT json_agg(json_build_object('version',l.version,'printed_at',l.printed_at,'reason',l.reason) ORDER BY l.version) FROM label_prints l WHERE l.package_id=p.id) AS prints
    FROM packages p JOIN orders o ON o.id=p.order_id JOIN products pr ON pr.id=o.product_id JOIN batches b ON b.id=p.batch_id JOIN organizations s ON s.id=p.supplier_id JOIN organizations bo ON bo.id=o.buyer_id
    LEFT JOIN order_groups g ON g.id=o.order_group_id JOIN categories c ON c.id=pr.category_id WHERE p.id=$1`, [req.params.id]);
  if (req.user!.role === 'SUPPLIER' && p.supplier_id !== req.user!.orgId) throw forbidden();
  // data penerima minimum pada label pengiriman (nama + alamat); tanpa telepon/email di QR publik
  res.json({ ...p, qr_payload: `SID:PKG:${p.package_no}`, code128: p.package_no, public_url: `/supplier-id/p/${p.package_no}` });
}));
fulfillmentRouter.post('/packages/:id/print', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ template: z.enum(['A4', 'THERMAL80']).default('A4'), reason: z.string().optional() }), req.body ?? {});
  res.json(await tx((c) => recordLabelPrint(c, req.params.id, req.user!, b)));
}));
fulfillmentRouter.post('/packages/:id/cancel', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  res.json(await tx((c) => cancelPackage(c, req.params.id, req.user!, b.reason)));
}));

/** SCAN (semua peran sesuai aksi): hasil OK/REJECTED selalu dicatat. */
fulfillmentRouter.post('/scan', requireRole('SUPPLIER', 'COURIER', 'BUYER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ code: z.string().min(3), action: z.enum(['HANDOVER', 'PICKUP', 'DELIVER', 'RECEIVE']), shipment_id: z.string().uuid().optional(), location: z.string().optional(), lat: z.coerce.number().optional(), lng: z.coerce.number().optional() }), req.body);
  const r = await tx((c) => scanPackage(c, req.user!, b));
  res.status(r.result === 'OK' ? 200 : 422).json(r);
}));
/** Laporan scan (admin/auditor) & per paket. */
fulfillmentRouter.get('/scans', requirePerm('orders.read', 'audit.read', 'scan'), asyncH(async (req, res) => {
  const { result, limit } = req.query as Record<string, string>;
  res.json(await q(pool, `SELECT s.*, u.name AS actor_name, p.package_no, p.order_id FROM package_scans s LEFT JOIN users u ON u.id=s.actor_id LEFT JOIN packages p ON p.id=s.package_id ${result ? 'WHERE s.result=$1' : 'WHERE $1::text IS NOT NULL'} ORDER BY s.scanned_at DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`, [result || 'all']));
}));

/** Info publik paket (QR): hanya data aman — tanpa alamat/telepon/nilai. */
fulfillmentRouter.get('/public/packages/:packageNo', asyncH(async (req, res) => {
  const p = await one(pool, `SELECT p.package_no, p.status, p.packed_at, p.quantity, p.unit, p.expiry_date, p.storage_instructions, pr.name AS product_name, b.batch_code, b.harvest_date, s.name AS supplier_name, s.region AS supplier_region
    FROM packages p JOIN orders o ON o.id=p.order_id JOIN products pr ON pr.id=o.product_id JOIN batches b ON b.id=p.batch_id JOIN organizations s ON s.id=p.supplier_id WHERE p.package_no=$1`, [req.params.packageNo.toUpperCase()]);
  res.json(p);
}));

/** Pelanggan memutuskan selisih berat (setuju bayar / tolak → kemas ulang). */
fulfillmentRouter.post('/orders/:id/weight-decision', requireRole('BUYER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['APPROVE', 'DECLINE']) }), req.body);
  res.json(await tx((c) => decideWeightVariance(c, req.params.id, req.user!, b.decision)));
}));

/** Traceability: batch → order → paket → pelanggan (admin) untuk investigasi/recall. */
fulfillmentRouter.get('/trace/batch/:batchId', requirePerm('orders.read', 'audit.read'), asyncH(async (req, res) => {
  const batch = await one(pool, `SELECT b.*, p.name AS product_name, s.name AS supplier_name FROM batches b JOIN products p ON p.id=b.product_id JOIN organizations s ON s.id=b.supplier_id WHERE b.id=$1`, [req.params.batchId]);
  const orders = await q(pool, `SELECT o.id, o.order_no, o.status, o.quantity, o.delivered_at, bo.name AS buyer_name,
      (SELECT json_agg(json_build_object('package_no',pk.package_no,'status',pk.status,'quantity',pk.quantity,'expiry_date',pk.expiry_date)) FROM packages pk WHERE pk.order_id=o.id) AS packages
    FROM orders o JOIN organizations bo ON bo.id=o.buyer_id WHERE o.batch_id=$1 ORDER BY o.created_at`, [batch.id]);
  res.json({ batch, orders });
}));
