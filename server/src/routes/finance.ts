/** PAYMENT TASKS — maker/checker, proses provider, inquiry, manual paid, reversal, hold/release; tampilan mitra. */
import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { asyncH, parse, forbidden, requireRole, requirePerm } from '../lib/http';
import { submitPaymentTask, approvePaymentTask, rejectPaymentTask, holdPaymentTask, releasePaymentTask, processPaymentTask, inquirePaymentTask, markPaidManual, reversePaymentTask, supplierNetForOrder, confirmReceived } from '../services/settlement';
import { getSetting } from '../services/config';

export const financeRouter = Router();

const PT_SELECT = `SELECT t.*, o.order_no, o.settled_at, o.confirmed_by, o.confirmation_at, o.trade_model, s.name AS supplier_name, s.bank_account, mk.name AS maker_name, ck.name AS checker_name, po.payout_no, po.status AS payout_status, po.provider, po.is_sandbox
  FROM payment_tasks t JOIN orders o ON o.id=t.order_id JOIN organizations s ON s.id=t.supplier_id LEFT JOIN users mk ON mk.id=t.maker_id LEFT JOIN users ck ON ck.id=t.checker_id LEFT JOIN payouts po ON po.id=t.payout_id`;

financeRouter.get('/finance/payment-tasks', requirePerm('finance.read', 'payouts.make', 'payouts.check'), asyncH(async (req, res) => {
  const { status, supplier_id } = req.query as Record<string, string>;
  const params: any[] = []; const where: string[] = [];
  if (status) { params.push(status.split(',')); where.push(`t.status = ANY($${params.length})`); }
  if (supplier_id) { params.push(supplier_id); where.push(`t.supplier_id=$${params.length}`); }
  const rows = await q(pool, `${PT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE t.status WHEN 'PENDING_APPROVAL' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'CREATED' THEN 2 WHEN 'PROCESSING' THEN 3 WHEN 'FAILED' THEN 4 WHEN 'ON_HOLD' THEN 5 ELSE 9 END, t.created_at DESC LIMIT 500`, params);
  const counts: Record<string, number> = {};
  for (const r of await q(pool, 'SELECT status, COUNT(*)::int AS n, COALESCE(SUM(net_amount),0) AS amount FROM payment_tasks GROUP BY status')) counts[r.status] = r.n;
  res.json({ tasks: rows, counts, provider: await getSetting(pool, 'payout.provider', 'NONE'), sla_hours: await getSetting(pool, 'payout.sla_hours', 24), me: { id: req.user!.id, admin_role: req.user!.adminRole, permissions: req.user!.permissions } });
}));

financeRouter.get('/finance/payment-tasks/:id', requirePerm('finance.read', 'payouts.make', 'payouts.check'), asyncH(async (req, res) => {
  const t = await one(pool, `${PT_SELECT} WHERE t.id=$1`, [req.params.id]);
  const events = await q(pool, 'SELECT e.*, u.name AS actor_name FROM payment_task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE task_id=$1 ORDER BY created_at', [t.id]);
  const ledger = await q(pool, `SELECT e.*, j.journal_type FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE e.order_id=$1 AND e.account='SUPPLIER_PAYABLE' ORDER BY e.posted_at`, [t.order_id]);
  res.json({ ...t, events, ledger, ledger_net: await supplierNetForOrder(pool, t.order_id, t.supplier_id) });
}));

financeRouter.post('/finance/payment-tasks/:id/submit', requirePerm('payouts.make'), asyncH(async (req, res) => res.json(await tx((c) => submitPaymentTask(c, req.params.id, req.user!)))));
financeRouter.post('/finance/payment-tasks/:id/approve', requirePerm('payouts.check'), asyncH(async (req, res) => res.json(await tx((c) => approvePaymentTask(c, req.params.id, req.user!)))));
financeRouter.post('/finance/payment-tasks/:id/reject', requirePerm('payouts.check'), asyncH(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  res.json(await tx((c) => rejectPaymentTask(c, req.params.id, req.user!, b.reason)));
}));
financeRouter.post('/finance/payment-tasks/:id/hold', requirePerm('payouts.make', 'payouts.check', 'orders.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  res.json(await tx((c) => holdPaymentTask(c, req.params.id, req.user!, b.reason)));
}));
financeRouter.post('/finance/payment-tasks/:id/release', requirePerm('payouts.check', 'orders.manage'), asyncH(async (req, res) => res.json(await tx((c) => releasePaymentTask(c, req.params.id, req.user!)))));
financeRouter.post('/finance/payment-tasks/:id/process', requirePerm('payouts.process'), asyncH(async (req, res) => res.json(await tx((c) => processPaymentTask(c, req.params.id, req.user!)))));
financeRouter.post('/finance/payment-tasks/:id/inquiry', requirePerm('payouts.process', 'payouts.check'), asyncH(async (req, res) => res.json(await tx((c) => inquirePaymentTask(c, req.params.id, req.user!.id)))));
financeRouter.post('/finance/payment-tasks/:id/mark-paid', requirePerm('payouts.check'), asyncH(async (req, res) => {
  const b = parse(z.object({ bank_ref: z.string().min(3) }), req.body);
  res.json(await tx((c) => markPaidManual(c, req.params.id, req.user!, b.bank_ref)));
}));
financeRouter.post('/finance/payment-tasks/:id/reverse', requirePerm('payouts.check'), asyncH(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  res.json(await tx((c) => reversePaymentTask(c, req.params.id, req.user!, b.reason)));
}));

/** Ops mengonfirmasi atas nama pelanggan (eskalasi CONFIRMATION_OVERDUE) — dana tidak dilepas otomatis tanpa keputusan manusia. */
financeRouter.post('/admin/orders/:id/ops-confirm', requirePerm('orders.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ note: z.string().min(3) }), req.body);
  const row = await tx(async (c) => {
    const r = await confirmReceived(c, req.params.id, 'OPS', req.user!.id);
    await q(c, `UPDATE orders SET needs_ops_review=FALSE WHERE id=$1`, [req.params.id]);
    await q(c, `UPDATE escalations SET status='RESOLVED', resolved_by=$2, resolution=$3, resolved_at=now() WHERE order_id=$1 AND kind='CONFIRMATION_OVERDUE' AND status='OPEN'`, [req.params.id, req.user!.id, b.note]);
    return r;
  });
  res.json(row);
}));

/** Mitra: pembayaran saya (task + status + SLA). */
financeRouter.get('/supplier/payment-tasks', requireRole('SUPPLIER'), asyncH(async (req, res) => {
  const rows = await q(pool, `SELECT t.id, t.task_no, t.status, t.trigger, t.eligible_quantity, t.gross_amount, t.adjustment_amount, t.net_amount, t.due_at, t.hold_reason, t.paid_at, t.provider_ref, t.created_at, t.approved_at, o.order_no, p.name AS product_name
    FROM payment_tasks t JOIN orders o ON o.id=t.order_id JOIN products p ON p.id=o.product_id WHERE t.supplier_id=$1 ORDER BY t.created_at DESC`, [req.user!.orgId]);
  res.json({ tasks: rows, sla_hours: await getSetting(pool, 'payout.sla_hours', 24) });
}));
