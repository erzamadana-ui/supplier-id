/** Jobs (cron ter-otentikasi), webhook pembayaran (HMAC + dedup), tiket CS, akun pelanggan (alamat, notifikasi), staf/kurir admin, eskalasi, dashboard ops. */
import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, q, one, maybe, tx, nextNo } from '../db';
import { asyncH, parse, bad, conflict, forbidden, requireRole, requirePerm, HttpError, ADMIN_ROLE_PERMS } from '../lib/http';
import { runJobs } from '../services/settlement';
import { audit } from '../services/config';
import { notify } from '../services/notify';
import { reconcile } from '../services/ledger';

export const opsRouter = Router();

// ---------------- JOBS ----------------
/** Dipanggil scheduler eksternal (GitHub Actions cron / cron-job.org / Vercel Cron) setiap 5–15 menit. Idempotent. */
opsRouter.post('/jobs/run', asyncH(async (req, res) => {
  const secret = process.env.JOB_SECRET;
  const given = req.headers['x-job-secret'] ?? req.query.secret;
  const isAdmin = req.user?.role === 'ADMIN' && (req.user.permissions ?? []).some((p) => p === '*' || p === 'orders.manage');
  if (!isAdmin && (!secret || given !== secret)) throw new HttpError(401, 'JOB_SECRET_INVALID');
  res.json(await runJobs(isAdmin ? `manual:${req.user!.email}` : 'cron'));
}));
opsRouter.get('/jobs/runs', requirePerm('settings.read', 'audit.read', 'orders.manage'), asyncH(async (_req, res) => res.json(await q(pool, 'SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 50'))));

// ---------------- WEBHOOK PEMBAYARAN (contoh kontrak generik: HMAC-SHA256 atas body mentah) ----------------
opsRouter.post('/webhooks/payment', asyncH(async (req, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  const raw = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
  const sig = String(req.headers['x-signature'] ?? '');
  const expected = secret ? crypto.createHmac('sha256', secret).update(raw).digest('hex') : null;
  const valid = !!expected && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  const b = req.body ?? {};
  const eventId = String(b.event_id ?? b.id ?? '');
  if (!eventId) throw bad('EVENT_ID_REQUIRED');
  if (!valid) { // tanda tangan palsu: dicatat untuk audit (tidak memakai event_id asli agar event sah berikutnya tetap diproses), lalu ditolak
    await q(pool, `INSERT INTO webhook_events(provider, event_id, event_type, payload, signature_valid, processed_at, result) VALUES ('PAYMENT_GATEWAY',$1,$2,$3::jsonb,FALSE,now(),'REJECTED_SIGNATURE')`, [`${eventId}:invalid:${Date.now()}`, b.type ?? null, JSON.stringify(b)]);
    throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID');
  }
  // dedup: event sah yang sama hanya diproses sekali (UNIQUE provider+event_id)
  const inserted = await maybe(pool, `INSERT INTO webhook_events(provider, event_id, event_type, payload, signature_valid) VALUES ('PAYMENT_GATEWAY',$1,$2,$3::jsonb,TRUE) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [eventId, b.type ?? null, JSON.stringify(b)]);
  if (!inserted) return res.json({ ok: true, duplicate: true });
  // Pemrosesan: hanya status yang sah untuk pembayaran PENDING; terlambat/ilegal diabaikan (tidak mengubah status)
  let result = 'IGNORED';
  if (b.type === 'payment.paid' && b.provider_ref) {
    const p = await maybe(pool, `SELECT * FROM payments WHERE provider_ref=$1`, [b.provider_ref]);
    if (p && p.status === 'PENDING') { await q(pool, `UPDATE payments SET status='PAID', paid_at=now(), provider_event_id=$2 WHERE id=$1`, [p.id, eventId]); result = 'APPLIED'; }
    else result = p ? `IGNORED_STATUS_${p.status}` : 'IGNORED_UNKNOWN_REF';
  }
  await q(pool, `UPDATE webhook_events SET processed_at=now(), result=$2 WHERE id=$1`, [inserted.id, result]);
  res.json({ ok: true, result });
}));

// ---------------- AKUN PELANGGAN: ALAMAT & NOTIFIKASI ----------------
opsRouter.get('/me/addresses', requireRole('BUYER'), asyncH(async (req, res) => res.json(await q(pool, 'SELECT * FROM buyer_addresses WHERE buyer_id=$1 ORDER BY is_default DESC, created_at', [req.user!.orgId]))));
const addrSchema = z.object({ label: z.string().default('Utama'), recipient: z.string().min(2), phone: z.string().min(6), address: z.string().min(5), city: z.string().optional(), province: z.string().optional(), postal_code: z.string().optional(), lat: z.coerce.number().optional(), lng: z.coerce.number().optional(), distance_km: z.coerce.number().min(0).default(0), is_default: z.coerce.boolean().default(false) });
opsRouter.post('/me/addresses', requireRole('BUYER'), asyncH(async (req, res) => {
  const b = parse(addrSchema, req.body);
  const row = await tx(async (c) => {
    const count = await one(c, 'SELECT COUNT(*)::int AS n FROM buyer_addresses WHERE buyer_id=$1', [req.user!.orgId]);
    const isDefault = b.is_default || count.n === 0;
    if (isDefault) await q(c, 'UPDATE buyer_addresses SET is_default=FALSE WHERE buyer_id=$1', [req.user!.orgId]);
    return one(c, `INSERT INTO buyer_addresses(buyer_id, label, recipient, phone, address, city, province, postal_code, lat, lng, distance_km, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user!.orgId, b.label, b.recipient, b.phone, b.address, b.city ?? null, b.province ?? null, b.postal_code ?? null, b.lat ?? null, b.lng ?? null, b.distance_km, isDefault]);
  });
  res.status(201).json(row);
}));
opsRouter.delete('/me/addresses/:id', requireRole('BUYER'), asyncH(async (req, res) => {
  await q(pool, 'DELETE FROM buyer_addresses WHERE id=$1 AND buyer_id=$2', [req.params.id, req.user!.orgId]);
  res.json({ ok: true });
}));
opsRouter.get('/me/notifications', requireRole(), asyncH(async (req, res) => {
  const rows = await q(pool, `SELECT * FROM notifications WHERE (org_id=$1 AND $1 IS NOT NULL) OR user_id=$2 ORDER BY created_at DESC LIMIT 100`, [req.user!.orgId, req.user!.id]);
  res.json({ items: rows, unread: rows.filter((r) => !r.read_at).length });
}));
opsRouter.post('/me/notifications/read', requireRole(), asyncH(async (req, res) => {
  await q(pool, `UPDATE notifications SET read_at=now() WHERE read_at IS NULL AND ((org_id=$1 AND $1 IS NOT NULL) OR user_id=$2)`, [req.user!.orgId, req.user!.id]);
  res.json({ ok: true });
}));
opsRouter.post('/me/push-token', requireRole(), asyncH(async (req, res) => {
  const b = parse(z.object({ platform: z.enum(['android', 'web']), token: z.string().min(10) }), req.body);
  await q(pool, `INSERT INTO push_tokens(user_id, platform, token) VALUES ($1,$2,$3) ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id`, [req.user!.id, b.platform, b.token]);
  res.json({ ok: true, note: 'Token tersimpan; pengiriman push aktif setelah kredensial FCM dikonfigurasi (FCM_SERVER_KEY).' });
}));
/** Mitra: rekening payout (perubahan tercatat audit; verifikasi oleh admin). */
opsRouter.put('/supplier/bank-account', requireRole('SUPPLIER'), asyncH(async (req, res) => {
  const b = parse(z.object({ bank_name: z.string().min(2), bank_account: z.string().min(5), bank_account_name: z.string().min(2) }), req.body);
  const before = await one(pool, 'SELECT bank_name, bank_account, bank_account_name FROM organizations WHERE id=$1', [req.user!.orgId]);
  const row = await tx(async (c) => {
    const r = await one(c, `UPDATE organizations SET bank_name=$2, bank_account=$3, bank_account_name=$4, bank_verified_at=NULL, bank_verified_by=NULL WHERE id=$1 RETURNING id, bank_name, bank_account, bank_account_name, bank_verified_at`, [req.user!.orgId, b.bank_name, b.bank_account, b.bank_account_name]);
    await audit(c, 'organizations', req.user!.orgId!, 'UPDATE', before, r, req.user!.id, 'Perubahan rekening payout oleh mitra (perlu verifikasi admin)');
    return r;
  });
  res.json(row);
}));

// ---------------- TIKET CS ----------------
const TICKET_SELECT = `SELECT t.*, o.order_no, bo.name AS buyer_name, so.name AS supplier_name, au.name AS assignee_name FROM tickets t LEFT JOIN orders o ON o.id=t.order_id LEFT JOIN organizations bo ON bo.id=t.buyer_id LEFT JOIN organizations so ON so.id=t.supplier_id LEFT JOIN users au ON au.id=t.assignee_id`;
opsRouter.get('/tickets', requireRole(), asyncH(async (req, res) => {
  const u = req.user!;
  const { status } = req.query as Record<string, string>;
  const params: any[] = []; const where: string[] = [];
  if (u.role === 'BUYER') { params.push(u.orgId); where.push(`t.buyer_id=$${params.length}`); }
  else if (u.role === 'SUPPLIER') { params.push(u.orgId); where.push(`t.supplier_id=$${params.length}`); }
  else if (u.role === 'COURIER') throw forbidden();
  else if (!(u.permissions ?? []).some((p) => p === '*' || p === 'tickets.read')) throw forbidden();
  if (status) { params.push(status.split(',')); where.push(`t.status = ANY($${params.length})`); }
  res.json(await q(pool, `${TICKET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE t.status WHEN 'OPEN' THEN 0 WHEN 'ESCALATED' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 5 END, t.priority, t.created_at DESC LIMIT 300`, params));
}));
opsRouter.post('/tickets', requireRole('BUYER', 'SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(z.object({ order_id: z.string().uuid().optional(), return_case_id: z.string().uuid().optional(), category: z.enum(['COMPLAINT', 'REFUND', 'DELIVERY', 'PAYMENT', 'OTHER']), subject: z.string().min(3), body: z.string().min(3), priority: z.coerce.number().int().min(1).max(5).default(3) }), req.body);
  const u = req.user!;
  const row = await tx(async (c) => {
    let o: any = null;
    if (b.order_id) {
      o = await one(c, 'SELECT * FROM orders WHERE id=$1', [b.order_id]);
      if (u.role === 'BUYER' && o.buyer_id !== u.orgId) throw forbidden();
      if (u.role === 'SUPPLIER' && o.supplier_id !== u.orgId) throw forbidden();
    }
    const t = await one(c, `INSERT INTO tickets(ticket_no, order_id, return_case_id, buyer_id, supplier_id, opened_by, category, subject, priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [await nextNo(c, 'ticket', 'TKT'), b.order_id ?? null, b.return_case_id ?? null, o?.buyer_id ?? (u.role === 'BUYER' ? u.orgId : null), o?.supplier_id ?? (u.role === 'SUPPLIER' ? u.orgId : null), u.id, b.category, b.subject, b.priority]);
    await q(c, 'INSERT INTO ticket_messages(ticket_id, author_id, author_role, body) VALUES ($1,$2,$3,$4)', [t.id, u.id, u.role, b.body]);
    if (o && b.category === 'COMPLAINT') await q(c, `UPDATE orders SET hold_reason=COALESCE(hold_reason, $2) WHERE id=$1 AND status NOT IN ('SETTLED','CANCELLED')`, [o.id, `Tiket ${t.ticket_no} terbuka`]);
    return t;
  });
  res.status(201).json(row);
}));
opsRouter.get('/tickets/:id', requireRole(), asyncH(async (req, res) => {
  const t = await one(pool, `${TICKET_SELECT} WHERE t.id=$1`, [req.params.id]);
  const u = req.user!;
  if (u.role === 'BUYER' && t.buyer_id !== u.orgId) throw forbidden();
  if (u.role === 'SUPPLIER' && t.supplier_id !== u.orgId) throw forbidden();
  const msgs = await q(pool, `SELECT m.*, us.name AS author_name FROM ticket_messages m LEFT JOIN users us ON us.id=m.author_id WHERE ticket_id=$1 ${u.role === 'ADMIN' ? '' : 'AND internal=FALSE'} ORDER BY created_at`, [t.id]);
  const evidence = await q(pool, `SELECT * FROM evidence_files WHERE owner_type='TICKET' AND (order_id=$1 OR return_case_id=$2) ORDER BY uploaded_at`, [t.order_id, t.return_case_id]);
  res.json({ ...t, messages: msgs, evidence });
}));
opsRouter.post('/tickets/:id/messages', requireRole(), asyncH(async (req, res) => {
  const b = parse(z.object({ body: z.string().min(1), internal: z.coerce.boolean().default(false) }), req.body);
  const t = await one(pool, 'SELECT * FROM tickets WHERE id=$1', [req.params.id]);
  const u = req.user!;
  if (u.role === 'BUYER' && t.buyer_id !== u.orgId) throw forbidden();
  if (u.role === 'SUPPLIER' && t.supplier_id !== u.orgId) throw forbidden();
  const m = await one(pool, 'INSERT INTO ticket_messages(ticket_id, author_id, author_role, body, internal) VALUES ($1,$2,$3,$4,$5) RETURNING *', [t.id, u.id, u.role, b.body, u.role === 'ADMIN' && b.internal]);
  await q(pool, `UPDATE tickets SET updated_at=now(), status=CASE WHEN $2='ADMIN' AND status='OPEN' THEN 'IN_PROGRESS' WHEN $2<>'ADMIN' AND status='WAITING_CUSTOMER' THEN 'IN_PROGRESS' ELSE status END WHERE id=$1`, [t.id, u.role]);
  res.status(201).json(m);
}));
opsRouter.patch('/tickets/:id', requirePerm('tickets.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED']).optional(), assignee_id: z.string().uuid().nullable().optional(), priority: z.coerce.number().int().min(1).max(5).optional(), resolution: z.string().optional() }), req.body);
  const t = await one(pool, 'SELECT * FROM tickets WHERE id=$1', [req.params.id]);
  const row = await tx(async (c) => {
    const r = await one(c, `UPDATE tickets SET status=COALESCE($2,status), assignee_id=CASE WHEN $6 THEN assignee_id ELSE $3 END, priority=COALESCE($4,priority), resolution=COALESCE($5,resolution), updated_at=now(),
      closed_at=CASE WHEN $2 IN ('RESOLVED','CLOSED') THEN now() ELSE closed_at END WHERE id=$1 RETURNING *`, [t.id, b.status ?? null, b.assignee_id ?? null, b.priority ?? null, b.resolution ?? null, b.assignee_id === undefined]);
    if (b.status && ['RESOLVED', 'CLOSED'].includes(b.status) && t.order_id) {
      const open = await maybe(c, `SELECT id FROM tickets WHERE order_id=$1 AND id<>$2 AND status NOT IN ('RESOLVED','CLOSED') AND category='COMPLAINT'`, [t.order_id, t.id]);
      if (!open) await q(c, `UPDATE orders SET hold_reason=NULL WHERE id=$1 AND hold_reason LIKE 'Tiket %'`, [t.order_id]);
    }
    return r;
  });
  res.json(row);
}));

// ---------------- ADMIN: STAF, KURIR, ESKALASI, DASHBOARD OPS ----------------
opsRouter.get('/admin/users', requirePerm('partners.manage', 'settings.read', 'audit.read'), asyncH(async (_req, res) => {
  res.json(await q(pool, `SELECT u.id, u.email, u.name, u.role, u.admin_role, u.permissions, u.phone, u.active, u.created_at, u.last_login_at, o.name AS org_name FROM users u LEFT JOIN organizations o ON o.id=u.org_id WHERE u.role IN ('ADMIN','COURIER') ORDER BY u.role, u.name`));
}));
opsRouter.get('/admin/roles', requireRole('ADMIN'), asyncH(async (_req, res) => res.json(ADMIN_ROLE_PERMS)));
/** Buat staf admin (peran granular) atau kurir. Hanya OWNER / partners.manage. Kata sandi awal diberikan sekali; wajib diganti. */
opsRouter.post('/admin/users', requirePerm('partners.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), name: z.string().min(2), password: z.string().min(8), role: z.enum(['ADMIN', 'COURIER']), admin_role: z.enum(['OWNER', 'OPS', 'QC', 'WAREHOUSE', 'DISPATCHER', 'CS', 'FINANCE_MAKER', 'FINANCE_CHECKER', 'AUDITOR']).optional(), phone: z.string().optional(), permissions: z.array(z.string()).default([]) }), req.body);
  if (b.role === 'ADMIN' && !b.admin_role) throw bad('ADMIN_ROLE_REQUIRED');
  if (b.admin_role === 'OWNER' && req.user!.adminRole && req.user!.adminRole !== 'OWNER') throw forbidden('ONLY_OWNER_CAN_CREATE_OWNER');
  if (await maybe(pool, 'SELECT 1 FROM users WHERE email=$1', [b.email])) throw conflict('EMAIL_EXISTS');
  const row = await tx(async (c) => {
    let orgId: string | null = null;
    if (b.role === 'COURIER') {
      const org = await maybe(c, `SELECT id FROM organizations WHERE type='LOGISTICS' AND name='Supplier-ID Delivery'`) ?? await one(c, `INSERT INTO organizations(type, name) VALUES ('LOGISTICS','Supplier-ID Delivery') RETURNING id`);
      orgId = org.id;
    }
    const u = await one(c, `INSERT INTO users(email, password_hash, name, role, org_id, admin_role, permissions, phone) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id, email, name, role, admin_role, permissions, phone, active`,
      [b.email, await bcrypt.hash(b.password, 10), b.name, b.role, orgId, b.role === 'ADMIN' ? b.admin_role : null, JSON.stringify(b.permissions), b.phone ?? null]);
    await audit(c, 'users', u.id, 'CREATE', null, { ...u }, req.user!.id, `Buat ${b.role}${b.admin_role ? ' ' + b.admin_role : ''}`);
    return u;
  });
  res.status(201).json(row);
}));
opsRouter.patch('/admin/users/:id', requirePerm('partners.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ admin_role: z.string().optional(), permissions: z.array(z.string()).optional(), active: z.coerce.boolean().optional(), phone: z.string().optional(), reset_password: z.string().min(8).optional() }), req.body);
  const before = await one(pool, 'SELECT id, admin_role, permissions, active, phone FROM users WHERE id=$1', [req.params.id]);
  if (before.id === req.user!.id && b.active === false) throw conflict('CANNOT_DEACTIVATE_SELF');
  const row = await tx(async (c) => {
    const r = await one(c, `UPDATE users SET admin_role=COALESCE($2,admin_role), permissions=COALESCE($3::jsonb,permissions), active=COALESCE($4,active), phone=COALESCE($5,phone),
      password_hash=COALESCE($6,password_hash), token_version=CASE WHEN $6 IS NOT NULL OR $4=FALSE THEN token_version+1 ELSE token_version END WHERE id=$1 RETURNING id, email, name, role, admin_role, permissions, active, phone`,
      [before.id, b.admin_role ?? null, b.permissions ? JSON.stringify(b.permissions) : null, b.active ?? null, b.phone ?? null, b.reset_password ? await bcrypt.hash(b.reset_password, 10) : null]);
    await audit(c, 'users', before.id, 'UPDATE', before, { ...r, password_reset: !!b.reset_password }, req.user!.id, 'Perubahan staf/kurir');
    return r;
  });
  res.json(row);
}));
/** Verifikasi rekening mitra (admin) — tercatat audit. */
opsRouter.post('/admin/organizations/:id/verify-bank', requirePerm('partners.manage', 'payouts.check'), asyncH(async (req, res) => {
  const before = await one(pool, 'SELECT id, bank_name, bank_account, bank_account_name, bank_verified_at FROM organizations WHERE id=$1', [req.params.id]);
  if (!before.bank_account) throw conflict('BANK_ACCOUNT_MISSING');
  const row = await tx(async (c) => {
    const r = await one(c, 'UPDATE organizations SET bank_verified_at=now(), bank_verified_by=$2 WHERE id=$1 RETURNING id, bank_name, bank_account, bank_account_name, bank_verified_at', [before.id, req.user!.id]);
    await audit(c, 'organizations', before.id, 'APPROVE', before, r, req.user!.id, 'Verifikasi rekening payout');
    return r;
  });
  res.json(row);
}));

opsRouter.get('/admin/escalations', requirePerm('escalations.manage', 'orders.read'), asyncH(async (req, res) => {
  const { status } = req.query as Record<string, string>;
  res.json(await q(pool, `SELECT e.*, o.order_no, o.status AS order_status, o.buyer_id, o.supplier_id, so.name AS supplier_name, bo.name AS buyer_name, t.task_no, t.stage
    FROM escalations e LEFT JOIN orders o ON o.id=e.order_id LEFT JOIN organizations so ON so.id=o.supplier_id LEFT JOIN organizations bo ON bo.id=o.buyer_id LEFT JOIN fulfillment_tasks t ON t.id=e.task_id
    WHERE e.status=$1 ORDER BY e.created_at DESC LIMIT 300`, [status || 'OPEN']));
}));
opsRouter.post('/admin/escalations/:id/resolve', requirePerm('escalations.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ resolution: z.string().min(3), clear_hold: z.coerce.boolean().default(false) }), req.body);
  const row = await tx(async (c) => {
    const e = await one(c, `UPDATE escalations SET status='RESOLVED', resolved_by=$2, resolution=$3, resolved_at=now() WHERE id=$1 RETURNING *`, [req.params.id, req.user!.id, b.resolution]);
    if (e.order_id) {
      const open = await maybe(c, `SELECT id FROM escalations WHERE order_id=$1 AND status='OPEN'`, [e.order_id]);
      if (!open) await q(c, `UPDATE orders SET needs_ops_review=FALSE${b.clear_hold ? ', hold_reason=NULL' : ''} WHERE id=$1`, [e.order_id]);
    }
    return e;
  });
  res.json(row);
}));

/** Dashboard ops actionable: order per stage, backlog/overdue, QC reject, gagal antar, komplain, payment task jatuh tempo, payout gagal, selisih rekonsiliasi. */
opsRouter.get('/admin/ops-dashboard', requirePerm('orders.read', 'finance.read', 'tasks.read'), asyncH(async (_req, res) => {
  const [byStage, tasks, qc, delivery, tickets, pt, esc, notif] = await Promise.all([
    q(pool, `SELECT status, COUNT(*)::int AS n FROM orders WHERE status NOT IN ('DRAFT','CANCELLED','SETTLED') GROUP BY status`),
    one(pool, `SELECT COUNT(*) FILTER (WHERE status IN ('NEW','AWAITING_RESPONSE','IN_PROGRESS','NEEDS_ACTION'))::int AS open, COUNT(*) FILTER (WHERE status='LATE' OR (deadline < now() AND status NOT IN ('DONE','REJECTED','CANCELLED')))::int AS overdue, COUNT(*) FILTER (WHERE status='NEEDS_ACTION')::int AS needs_action FROM fulfillment_tasks`),
    one(pool, `SELECT COUNT(*) FILTER (WHERE passed=FALSE AND created_at > now() - interval '30 days')::int AS rejects_30d, COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS total_30d FROM qc_records`),
    one(pool, `SELECT COUNT(*) FILTER (WHERE status='DELIVERY_FAILED')::int AS failed, COUNT(*) FILTER (WHERE status IN ('SCHEDULED','PICKED_UP','IN_TRANSIT'))::int AS active FROM shipments WHERE type='DELIVERY'`),
    one(pool, `SELECT COUNT(*) FILTER (WHERE status IN ('OPEN','ESCALATED'))::int AS open, COUNT(*) FILTER (WHERE status='IN_PROGRESS')::int AS in_progress FROM tickets`),
    q(pool, `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(net_amount),0) AS amount, COUNT(*) FILTER (WHERE due_at < now() AND status IN ('APPROVED','PROCESSING'))::int AS overdue FROM payment_tasks GROUP BY status`),
    q(pool, `SELECT kind, COUNT(*)::int AS n FROM escalations WHERE status='OPEN' GROUP BY kind`),
    one(pool, `SELECT COUNT(*)::int AS n FROM orders WHERE status='ARRIVED_WAITING_INSPECTION' AND confirmation_due_at < now() + interval '2 hours' AND confirmation_due_at > now()`),
  ]);
  const rec = await reconcile(pool);
  res.json({ orders_by_stage: byStage, tasks, qc, delivery, tickets, payment_tasks: pt, escalations: esc, confirmations_due_soon: notif.n, reconciliation: { balanced: rec.balanced, variance: rec.variance }, last_job: await maybe(pool, 'SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 1') });
}));
