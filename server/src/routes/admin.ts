import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, maybe, tx, nextNo } from '../db';
import { asyncH, parse, bad, requireRole, conflict, money } from '../lib/http';
import { audit, getSetting, setSetting, resolvePlatformFee } from '../services/config';
import { accountBalances, postJournal, reconcile } from '../services/ledger';
import { recomputeQualityScore } from '../services/quality';
import { deleteObjects } from '../lib/storage';

export const adminRouter = Router();
adminRouter.use(requireRole('ADMIN'));

// ---------------- FEES & MONETIZATION ----------------
adminRouter.get('/fees', asyncH(async (req, res) => {
  const rows = await q(pool, `SELECT f.*, cu.name AS created_by_name, au.name AS approved_by_name FROM fee_configs f LEFT JOIN users cu ON cu.id=f.created_by LEFT JOIN users au ON au.id=f.approved_by ORDER BY f.effective_from DESC, f.created_at DESC`);
  const current = await resolvePlatformFee(pool, {});
  res.json({ current, history: rows, requires_approval: await getSetting(pool, 'fee.change_requires_approval', false) });
}));

const feeSchema = z.object({
  rate_percent: z.coerce.number().min(0).max(100),
  scope_type: z.enum(['GLOBAL', 'CATEGORY', 'SUPPLIER', 'BUYER', 'CONTRACT', 'PROMOTION', 'VALUE_TIER', 'REGION']).default('GLOBAL'),
  scope_ref: z.string().optional(),
  effective_from: z.string().optional(),
  effective_to: z.string().optional(),
  reason: z.string().min(3),
});

/** Ubah platform fee: effective date, previous value, reason, created_by, approval opsional, audit log. Order lama tidak berubah. */
adminRouter.post('/fees', asyncH(async (req, res) => {
  const b = parse(feeSchema, req.body);
  if (b.scope_type !== 'GLOBAL' && !b.scope_ref) throw bad('SCOPE_REF_REQUIRED');
  const requiresApproval = await getSetting(pool, 'fee.change_requires_approval', false);
  const effFrom = b.effective_from ? new Date(b.effective_from) : new Date();
  const row = await tx(async (c) => {
    const prev = await maybe(c, `SELECT * FROM fee_configs WHERE fee_key='PLATFORM_FEE' AND scope_type=$1 AND COALESCE(scope_ref,'')=COALESCE($2,'') AND status='ACTIVE' AND (effective_to IS NULL OR effective_to > $3) ORDER BY effective_from DESC LIMIT 1`, [b.scope_type, b.scope_ref ?? null, effFrom]);
    const status = requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE';
    const f = await one(c,
      `INSERT INTO fee_configs(fee_key, scope_type, scope_ref, rate_percent, effective_from, effective_to, previous_value, reason, status, created_by)
       VALUES ('PLATFORM_FEE',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.scope_type, b.scope_ref ?? null, b.rate_percent, effFrom, b.effective_to ? new Date(b.effective_to) : null, prev?.rate_percent ?? null, b.reason, status, req.user!.id]);
    if (status === 'ACTIVE' && prev) {
      // fee lama berakhir saat fee baru berlaku (tanpa memutus fee yang masih berlaku sebelum effective_from)
      await q(c, `UPDATE fee_configs SET effective_to=$2, status=CASE WHEN $2<=now() THEN 'SUPERSEDED' ELSE status END WHERE id=$1 AND (effective_to IS NULL OR effective_to > $2)`, [prev.id, effFrom]);
    }
    await audit(c, 'fee_configs', f.id, 'CREATE', prev ? { rate_percent: prev.rate_percent, id: prev.id } : null, f, req.user!.id, b.reason);
    return f;
  });
  res.status(201).json(row);
}));

adminRouter.post('/fees/:id/approve', asyncH(async (req, res) => {
  const f = await one(pool, 'SELECT * FROM fee_configs WHERE id=$1', [req.params.id]);
  if (f.status !== 'PENDING_APPROVAL') throw conflict('NOT_PENDING');
  if (f.created_by === req.user!.id) throw conflict('APPROVER_MUST_DIFFER');
  const row = await tx(async (c) => {
    const prev = await maybe(c, `SELECT * FROM fee_configs WHERE id<>$1 AND fee_key='PLATFORM_FEE' AND scope_type=$2 AND COALESCE(scope_ref,'')=COALESCE($3,'') AND status='ACTIVE' AND (effective_to IS NULL OR effective_to > $4) ORDER BY effective_from DESC LIMIT 1`, [f.id, f.scope_type, f.scope_ref, f.effective_from]);
    if (prev) await q(c, `UPDATE fee_configs SET effective_to=$2, status=CASE WHEN $2<=now() THEN 'SUPERSEDED' ELSE status END WHERE id=$1`, [prev.id, f.effective_from]);
    const upd = await one(c, `UPDATE fee_configs SET status='ACTIVE', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [f.id, req.user!.id]);
    await audit(c, 'fee_configs', f.id, 'APPROVE', f, upd, req.user!.id);
    return upd;
  });
  res.json(row);
}));

adminRouter.post('/fees/:id/reject', asyncH(async (req, res) => {
  const f = await one(pool, 'SELECT * FROM fee_configs WHERE id=$1', [req.params.id]);
  if (f.status !== 'PENDING_APPROVAL') throw conflict('NOT_PENDING');
  const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
  const upd = await one(pool, `UPDATE fee_configs SET status='REJECTED', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [f.id, req.user!.id]);
  await audit(pool, 'fee_configs', f.id, 'REJECT', f, upd, req.user!.id, reason);
  res.json(upd);
}));

// ---------------- TAX RULES ----------------
adminRouter.get('/tax-rules', asyncH(async (_req, res) => res.json(await q(pool, 'SELECT * FROM tax_rules ORDER BY component, priority'))));
adminRouter.post('/tax-rules', asyncH(async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(3), component: z.enum(['PRODUCT', 'PLATFORM_FEE', 'PACKAGING', 'LOGISTICS', 'PAYMENT_FEE', 'OPTIONAL_SERVICE']),
    transaction_type: z.string().default('ANY'), seller_status: z.string().default('ANY'), buyer_status: z.string().default('ANY'), service_type: z.string().default('ANY'),
    taxable: z.boolean().default(true), rate_percent: z.coerce.number().min(0).max(100).default(0), dpp_factor: z.coerce.number().positive().default(1), priority: z.coerce.number().int().default(100),
    effective_from: z.string().optional(), reason: z.string().optional(),
  }), req.body);
  const r = await one(pool,
    `INSERT INTO tax_rules(name, component, transaction_type, seller_status, buyer_status, service_type, taxable, rate_percent, dpp_factor, priority, effective_from, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()),$12) RETURNING *`,
    [b.name, b.component, b.transaction_type, b.seller_status, b.buyer_status, b.service_type, b.taxable, b.rate_percent, b.dpp_factor, b.priority, b.effective_from ?? null, req.user!.id]);
  await audit(pool, 'tax_rules', r.id, 'CREATE', null, r, req.user!.id, b.reason);
  res.status(201).json(r);
}));
adminRouter.patch('/tax-rules/:id', asyncH(async (req, res) => {
  const cur = await one(pool, 'SELECT * FROM tax_rules WHERE id=$1', [req.params.id]);
  const b = parse(z.object({ taxable: z.boolean().optional(), rate_percent: z.coerce.number().min(0).max(100).optional(), dpp_factor: z.coerce.number().positive().optional(), active: z.boolean().optional(), priority: z.coerce.number().int().optional(), effective_to: z.string().nullable().optional(), reason: z.string().optional() }), req.body);
  const r = await one(pool,
    `UPDATE tax_rules SET taxable=COALESCE($2,taxable), rate_percent=COALESCE($3,rate_percent), dpp_factor=COALESCE($4,dpp_factor), active=COALESCE($5,active), priority=COALESCE($6,priority), effective_to=COALESCE($7::timestamptz, effective_to) WHERE id=$1 RETURNING *`,
    [cur.id, b.taxable ?? null, b.rate_percent ?? null, b.dpp_factor ?? null, b.active ?? null, b.priority ?? null, b.effective_to ?? null]);
  await audit(pool, 'tax_rules', r.id, 'UPDATE', cur, r, req.user!.id, b.reason);
  res.json(r);
}));

// ---------------- SETTINGS (packaging, logistics, payment, return policy, quality, evidence) ----------------
adminRouter.get('/settings', asyncH(async (_req, res) => res.json(await q(pool, 'SELECT * FROM settings ORDER BY key'))));
adminRouter.put('/settings/:key', asyncH(async (req, res) => {
  const { value, reason } = parse(z.object({ value: z.any(), reason: z.string().optional() }), req.body);
  await setSetting(pool, req.params.key, value, req.user!.id, reason);
  res.json(await one(pool, 'SELECT * FROM settings WHERE key=$1', [req.params.key]));
}));

// ---------------- REASON CODES ----------------
adminRouter.get('/reason-codes', asyncH(async (_req, res) => res.json(await q(pool, 'SELECT * FROM return_reason_codes ORDER BY sort_order'))));
adminRouter.put('/reason-codes/:code', asyncH(async (req, res) => {
  const b = parse(z.object({ label: z.string().min(2), requires_video: z.boolean().default(true), active: z.boolean().default(true), sort_order: z.coerce.number().int().default(100) }), req.body);
  const before = await maybe(pool, 'SELECT * FROM return_reason_codes WHERE code=$1', [req.params.code]);
  const r = await one(pool,
    `INSERT INTO return_reason_codes(code, label, requires_video, active, sort_order) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label, requires_video=EXCLUDED.requires_video, active=EXCLUDED.active, sort_order=EXCLUDED.sort_order RETURNING *`,
    [req.params.code.toUpperCase(), b.label, b.requires_video, b.active, b.sort_order]);
  await audit(pool, 'return_reason_codes', r.code, before ? 'UPDATE' : 'CREATE', before, r, req.user!.id);
  res.json(r);
}));

// ---------------- CATEGORIES (skema atribut dinamis) ----------------
adminRouter.get('/categories', asyncH(async (_req, res) => res.json(await q(pool, 'SELECT * FROM categories ORDER BY name'))));
adminRouter.get('/audit-logs', asyncH(async (req, res) => {
  const { entity, limit } = req.query as Record<string, string>;
  res.json(await q(pool, `SELECT a.*, u.name AS user_name FROM config_audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ($1::text IS NULL OR a.entity=$1) ORDER BY a.created_at DESC LIMIT $2`, [entity ?? null, Number(limit ?? 200)]));
}));
adminRouter.put('/categories/:code', asyncH(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(2), attribute_schema: z.array(z.any()).default([]), tax_class: z.string().default('STANDARD'), min_photos: z.coerce.number().int().nullable().optional(), packaging_rate_per_unit: z.coerce.number().nullable().optional(), active: z.boolean().default(true) }), req.body);
  const before = await maybe(pool, 'SELECT * FROM categories WHERE code=$1', [req.params.code]);
  const r = await one(pool,
    `INSERT INTO categories(code, name, attribute_schema, tax_class, min_photos, packaging_rate_per_unit, active) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, attribute_schema=EXCLUDED.attribute_schema, tax_class=EXCLUDED.tax_class, min_photos=EXCLUDED.min_photos, packaging_rate_per_unit=EXCLUDED.packaging_rate_per_unit, active=EXCLUDED.active RETURNING *`,
    [req.params.code.toUpperCase(), b.name, JSON.stringify(b.attribute_schema), b.tax_class, b.min_photos ?? null, b.packaging_rate_per_unit ?? null, b.active]);
  await audit(pool, 'categories', r.code, before ? 'UPDATE' : 'CREATE', before, r, req.user!.id);
  res.json(r);
}));

// ---------------- ORGANIZATIONS / SUPPLIERS ----------------
adminRouter.get('/organizations', asyncH(async (req, res) => {
  const type = req.query.type as string | undefined;
  res.json(await q(pool,
    `SELECT o.*, (SELECT score FROM supplier_quality_scores s WHERE s.supplier_id=o.id ORDER BY computed_at DESC LIMIT 1) AS quality_score,
            (SELECT enforcement FROM supplier_quality_scores s WHERE s.supplier_id=o.id ORDER BY computed_at DESC LIMIT 1) AS enforcement,
            (SELECT COUNT(*) FROM orders x WHERE x.supplier_id=o.id OR x.buyer_id=o.id)::int AS order_count
     FROM organizations o WHERE ($1::text IS NULL OR o.type=$1::org_type) ORDER BY o.created_at`, [type ?? null]));
}));
adminRouter.patch('/organizations/:id', asyncH(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['ACTIVE', 'WARNING', 'VERIFICATION_REQUIRED', 'LISTING_LIMITED', 'UNDER_REVIEW', 'SUSPENDED']).optional(), verified: z.boolean().optional(), tax_status: z.enum(['PKP', 'NON_PKP']).optional(), reason: z.string().optional() }), req.body);
  const before = await one(pool, 'SELECT * FROM organizations WHERE id=$1', [req.params.id]);
  const r = await one(pool, `UPDATE organizations SET status=COALESCE($2,status), verified=COALESCE($3,verified), tax_status=COALESCE($4,tax_status), status_reason=COALESCE($5,status_reason) WHERE id=$1 RETURNING *`,
    [before.id, b.status ?? null, b.verified ?? null, b.tax_status ?? null, b.reason ?? null]);
  await audit(pool, 'organizations', r.id, 'UPDATE', before, r, req.user!.id, b.reason);
  res.json(r);
}));
adminRouter.post('/quality/recompute', asyncH(async (req, res) => {
  const ids = req.body?.supplier_id ? [req.body.supplier_id] : (await q(pool, `SELECT id FROM organizations WHERE type='SUPPLIER'`)).map((r) => r.id);
  const out = [];
  for (const id of ids) out.push({ supplier_id: id, ...(await recomputeQualityScore(pool, id, req.user!.id)) });
  res.json(out);
}));
adminRouter.get('/quality', asyncH(async (_req, res) => {
  res.json(await q(pool,
    `SELECT DISTINCT ON (s.supplier_id) s.*, o.name AS supplier_name, o.status AS org_status FROM supplier_quality_scores s JOIN organizations o ON o.id=s.supplier_id ORDER BY s.supplier_id, s.computed_at DESC`));
}));

// ---------------- LEDGER, RECONCILIATION, AUDIT ----------------
adminRouter.get('/ledger', asyncH(async (req, res) => {
  const { order_id, account, limit } = req.query as Record<string, string>;
  const where: string[] = []; const params: any[] = [];
  if (order_id) { params.push(order_id); where.push(`e.order_id=$${params.length}`); }
  if (account) { params.push(account); where.push(`e.account=$${params.length}`); }
  params.push(Number(limit ?? 500));
  res.json(await q(pool,
    `SELECT e.*, j.journal_type, j.reference, o.order_no FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id LEFT JOIN orders o ON o.id=e.order_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.posted_at DESC, e.side LIMIT $${params.length}`, params));
}));
adminRouter.get('/ledger/balances', asyncH(async (_req, res) => res.json(await accountBalances(pool))));
adminRouter.get('/reconcile', asyncH(async (req, res) => res.json(await reconcile(pool, req.query.order_id as string | undefined))));

// ---------------- PAYOUTS ----------------
adminRouter.get('/payouts', asyncH(async (_req, res) => {
  const pending = await q(pool,
    `SELECT o.id AS supplier_id, o.name AS supplier_name, o.bank_account,
            COALESCE(SUM(CASE WHEN e.side='CREDIT' THEN e.amount ELSE -e.amount END),0) AS payable_balance,
            (SELECT COUNT(*) FROM orders x WHERE x.supplier_id=o.id AND x.status='SETTLED' AND NOT EXISTS (SELECT 1 FROM ledger_entries y WHERE y.order_id=x.id AND y.component='SUPPLIER_PAYOUT'))::int AS settled_unpaid_orders
     FROM organizations o LEFT JOIN ledger_entries e ON e.party_id=o.id AND e.account='SUPPLIER_PAYABLE'
     WHERE o.type='SUPPLIER' GROUP BY o.id ORDER BY payable_balance DESC`);
  const history = await q(pool, `SELECT p.*, o.name AS supplier_name FROM payouts p JOIN organizations o ON o.id=p.supplier_id ORDER BY p.created_at DESC`);
  res.json({ pending, history });
}));

/** Jalankan payout untuk order SETTLED yang belum dibayar: DR SUPPLIER_PAYABLE / CR CASH per order. */
adminRouter.post('/payouts/run', asyncH(async (req, res) => {
  const { supplier_id } = parse(z.object({ supplier_id: z.string().uuid() }), req.body);
  const row = await tx(async (c) => {
    const orders = await q(c,
      `SELECT x.id, x.order_no, x.supplier_id,
              COALESCE((SELECT SUM(CASE WHEN e.side='CREDIT' THEN e.amount ELSE -e.amount END) FROM ledger_entries e WHERE e.order_id=x.id AND e.account='SUPPLIER_PAYABLE' AND e.party_id=x.supplier_id),0) AS net
       FROM orders x WHERE x.supplier_id=$1 AND x.status='SETTLED'
         AND NOT EXISTS (SELECT 1 FROM ledger_entries y WHERE y.order_id=x.id AND y.component='SUPPLIER_PAYOUT')`, [supplier_id]);
    const payable = orders.filter((o) => Number(o.net) > 0);
    const total = money(payable.reduce((a, o) => a + Number(o.net), 0));
    if (total <= 0) throw conflict('NOTHING_TO_PAY');
    const payoutNo = await nextNo(c, 'payout', 'PO');
    const jid = await postJournal(c, { type: 'SUPPLIER_PAYOUT', reference: payoutNo, memo: `Payout ke supplier`, createdBy: req.user!.id },
      payable.flatMap((o) => [
        { account: 'SUPPLIER_PAYABLE' as const, component: 'SUPPLIER_PAYOUT' as const, side: 'DEBIT' as const, amount: Number(o.net), partyType: 'SUPPLIER' as const, partyId: supplier_id, memo: o.order_no },
        { account: 'CASH' as const, component: 'CASH_OUT' as const, side: 'CREDIT' as const, amount: Number(o.net), partyType: 'SUPPLIER' as const, partyId: supplier_id, memo: o.order_no },
      ]));
    // tautkan entri ke order agar payout per order dapat dilacak
    for (const o of payable) await q(c, `UPDATE ledger_entries SET order_id=$2 WHERE journal_id=$1 AND memo=$3`, [jid, o.id, o.order_no]);
    return one(c, `INSERT INTO payouts(payout_no, supplier_id, amount, order_ids, status, journal_id, bank_ref, paid_at, created_by) VALUES ($1,$2,$3,$4::jsonb,'PAID',$5,$6,now(),$7) RETURNING *`,
      [payoutNo, supplier_id, total, JSON.stringify(payable.map((o) => o.id)), jid, `TRF-${Date.now()}`, req.user!.id]);
  });
  res.status(201).json(row);
}));

// ---------------- MONETIZATION DASHBOARD ----------------
adminRouter.get('/monetization', asyncH(async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const params = [from ? new Date(from) : new Date('2000-01-01'), to ? new Date(to) : new Date('2100-01-01')];
  const g = async (component: string, side: 'DEBIT' | 'CREDIT') => Number((await one(pool, `SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE component=$3 AND side=$4 AND posted_at BETWEEN $1 AND $2`, [...params, component, side])).v);
  const paidOrders = await one(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0) AS gmv, COALESCE(SUM(product_value),0) AS product_value FROM orders WHERE paid_at BETWEEN $1 AND $2`, params);
  const platformFeeRevenue = money((await g('PLATFORM_FEE_REVENUE', 'CREDIT')) - (await g('PLATFORM_FEE_REVENUE', 'DEBIT')));
  const packagingRevenue = money((await g('PACKAGING_REVENUE', 'CREDIT')) - (await g('PACKAGING_REVENUE', 'DEBIT')));
  const packagingCost = await g('PACKAGING_COST', 'DEBIT');
  const logisticsRevenue = money((await g('LOGISTICS_REVENUE', 'CREDIT')) - (await g('LOGISTICS_REVENUE', 'DEBIT')));
  const logisticsCost = Number((await one(pool, `SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE account='LOGISTICS_COST' AND side='DEBIT' AND posted_at BETWEEN $1 AND $2`, params)).v);
  const paymentFeesCollected = money((await g('PAYMENT_FEE', 'CREDIT')) - (await g('PAYMENT_FEE', 'DEBIT')));
  const paymentProcessingFee = await g('PAYMENT_PROCESSING_FEE', 'DEBIT');
  const tax = money((await g('TAX_PAYABLE', 'CREDIT')) - (await g('TAX_PAYABLE', 'DEBIT')));
  const refunds = await g('REFUND', 'CREDIT');
  const returnCost = Number((await one(pool, `SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE account='RETURN_ADJUSTMENT' AND side='DEBIT' AND posted_at BETWEEN $1 AND $2`, params)).v);
  const optional = money((await g('OPTIONAL_SERVICE', 'CREDIT')) - (await g('OPTIONAL_SERVICE', 'DEBIT')));
  const discount = money((await g('PROMOTION_DISCOUNT', 'DEBIT')) - (await g('PROMOTION_DISCOUNT', 'CREDIT')));
  const recovery = await g('LOGISTICS_RECOVERY', 'DEBIT');
  const supplierPayable = (await accountBalances(pool)).SUPPLIER_PAYABLE?.net ?? 0;
  const returns = await one(pool, `SELECT COUNT(*)::int AS n, COALESCE(SUM(approved_quantity),0) AS qty FROM return_cases WHERE created_at BETWEEN $1 AND $2`, params);
  const netRevenue = money(platformFeeRevenue + (packagingRevenue - packagingCost) + (logisticsRevenue - logisticsCost) + optional + (paymentFeesCollected - paymentProcessingFee) - discount - returnCost);
  const takeRate = Number(paidOrders.product_value) > 0 ? money((platformFeeRevenue / Number(paidOrders.product_value)) * 100) : 0;

  const byDay = await q(pool,
    `SELECT d::date AS day,
            COALESCE((SELECT SUM(total_amount) FROM orders o WHERE o.paid_at::date=d::date),0) AS gmv,
            COALESCE((SELECT SUM(CASE WHEN e.side='CREDIT' THEN e.amount ELSE -e.amount END) FROM ledger_entries e WHERE e.posted_at::date=d::date AND e.account IN ('PLATFORM_FEE_REVENUE','PACKAGING_REVENUE','LOGISTICS_REVENUE','OPTIONAL_SERVICE_REVENUE')),0) AS revenue,
            COALESCE((SELECT SUM(CASE WHEN e.side='CREDIT' THEN e.amount ELSE -e.amount END) FROM ledger_entries e WHERE e.posted_at::date=d::date AND e.account='PLATFORM_FEE_REVENUE'),0) AS platform_fee
     FROM generate_series(GREATEST($1::date, CURRENT_DATE-29), LEAST($2::date, CURRENT_DATE), '1 day') d ORDER BY d`, params);
  const byCategory = await q(pool,
    `SELECT c.name AS category, COALESCE(SUM(o.platform_fee_amount),0) AS platform_fee, COALESCE(SUM(o.total_amount),0) AS gmv, COUNT(*)::int AS orders
     FROM orders o JOIN products p ON p.id=o.product_id JOIN categories c ON c.id=p.category_id WHERE o.paid_at BETWEEN $1 AND $2 GROUP BY c.name ORDER BY platform_fee DESC`, params);
  const byBuyer = await q(pool, `SELECT b.name AS buyer, COALESCE(SUM(o.platform_fee_amount),0) AS platform_fee, COALESCE(SUM(o.total_amount),0) AS gmv, COUNT(*)::int AS orders FROM orders o JOIN organizations b ON b.id=o.buyer_id WHERE o.paid_at BETWEEN $1 AND $2 GROUP BY b.name ORDER BY platform_fee DESC LIMIT 10`, params);
  const bySupplier = await q(pool, `SELECT s.name AS supplier, COALESCE(SUM(o.platform_fee_amount),0) AS platform_fee, COALESCE(SUM(o.product_value),0) AS product_value, COUNT(*)::int AS orders FROM orders o JOIN organizations s ON s.id=o.supplier_id WHERE o.paid_at BETWEEN $1 AND $2 GROUP BY s.name ORDER BY platform_fee DESC LIMIT 10`, params);

  res.json({
    cards: {
      gmv: Number(paidOrders.gmv), paid_orders: paidOrders.n, product_value: Number(paidOrders.product_value),
      platform_fee_revenue: platformFeeRevenue, average_take_rate_pct: takeRate,
      packaging_revenue: packagingRevenue, packaging_cost: packagingCost, packaging_profit: money(packagingRevenue - packagingCost),
      logistics_revenue: logisticsRevenue, logistics_cost: logisticsCost, logistics_margin: money(logisticsRevenue - logisticsCost),
      payment_fees_collected: paymentFeesCollected, payment_processing_fee: paymentProcessingFee,
      optional_service_revenue: optional, promotion_discount: discount,
      tax: tax, refunds, return_cases: returns.n, return_cost: returnCost, logistics_recovery: recovery,
      supplier_payable: supplierPayable, net_revenue: netRevenue,
    },
    charts: { gmv_by_day: byDay, revenue_by_category: byCategory, revenue_by_buyer: byBuyer, revenue_by_supplier: bySupplier },
    current_platform_fee: await resolvePlatformFee(pool, {}),
    reconciliation: await reconcile(pool),
  });
}));

// ---------------- DATA UJI (TEST DATA) ----------------
/** Organisasi uji: nama diawali "UJI " atau user ber-email uji-*@supplier.id. */
async function testOrgIds(db: Parameters<typeof q>[0]): Promise<string[]> {
  const rows = await q<{ id: string }>(db, `SELECT id FROM organizations WHERE name LIKE 'UJI %' OR id IN (SELECT org_id FROM users WHERE email LIKE 'uji-%@supplier.id' AND org_id IS NOT NULL)`);
  return rows.map((r) => r.id);
}

/** Pratinjau: apa saja yang akan dihapus oleh purge data uji. */
adminRouter.get('/test-data', asyncH(async (_req, res) => {
  const orgs = await testOrgIds(pool);
  if (!orgs.length) return res.json({ organizations: [], orders: 0, evidence_files: 0, ledger_journals: 0 });
  const [o, e, j, names] = await Promise.all([
    one(pool, `SELECT count(*)::int AS n FROM orders WHERE buyer_id = ANY($1) OR supplier_id = ANY($1)`, [orgs]),
    one(pool, `SELECT count(*)::int AS n FROM evidence_files WHERE supplier_id = ANY($1) OR buyer_id = ANY($1)`, [orgs]),
    one(pool, `SELECT count(*)::int AS n FROM ledger_journals WHERE order_id IN (SELECT id FROM orders WHERE buyer_id = ANY($1) OR supplier_id = ANY($1)) OR id IN (SELECT journal_id FROM payouts WHERE supplier_id = ANY($1))`, [orgs]),
    q(pool, `SELECT id, name, type FROM organizations WHERE id = ANY($1) ORDER BY name`, [orgs]),
  ]);
  res.json({ organizations: names, orders: o.n, evidence_files: e.n, ledger_journals: j.n });
}));

/**
 * Hapus seluruh data uji (org UJI beserta user, produk, batch, order, bukti, ledger, payout, override fee) secara transaksional.
 * Wajib konfirmasi literal. Data produksi lain tidak disentuh; rekonsiliasi global tetap seimbang karena jurnal dihapus utuh per order.
 */
adminRouter.post('/test-data/purge', asyncH(async (req, res) => {
  const b = parse(z.object({ confirm: z.literal('HAPUS DATA UJI') }), req.body);
  void b;
  const result = await tx(async (c) => {
    const orgs = await testOrgIds(c);
    if (!orgs.length) return { organizations: 0, orders: 0, evidence_files: 0, storage_objects: 0 };
    const users = (await q<{ id: string }>(c, `SELECT id FROM users WHERE org_id = ANY($1)`, [orgs])).map((r) => r.id);
    const orders = (await q<{ id: string }>(c, `SELECT id FROM orders WHERE buyer_id = ANY($1) OR supplier_id = ANY($1)`, [orgs])).map((r) => r.id);
    const files = await q<{ file_path: string }>(c, `SELECT file_path FROM evidence_files WHERE supplier_id = ANY($1) OR buyer_id = ANY($1) OR order_id = ANY($2) OR uploaded_by = ANY($3)`, [orgs, orders, users]);
    const journals = (await q<{ id: string }>(c,
      `SELECT id FROM ledger_journals WHERE order_id = ANY($1)
         OR return_case_id IN (SELECT id FROM return_cases WHERE order_id = ANY($1))
         OR id IN (SELECT journal_id FROM payouts WHERE supplier_id = ANY($2) AND journal_id IS NOT NULL)`, [orders, orgs])).map((r) => r.id);
    // urutan sesuai ketergantungan FK (tanpa ON DELETE CASCADE)
    await q(c, `DELETE FROM payouts WHERE supplier_id = ANY($1)`, [orgs]);
    await q(c, `DELETE FROM ledger_entries WHERE journal_id = ANY($1) OR order_id = ANY($2)`, [journals, orders]);
    await q(c, `DELETE FROM ledger_journals WHERE id = ANY($1)`, [journals]);
    await q(c, `DELETE FROM financial_adjustments WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM disputes WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM evidence_files WHERE supplier_id = ANY($1) OR buyer_id = ANY($1) OR order_id = ANY($2) OR uploaded_by = ANY($3)`, [orgs, orders, users]);
    await q(c, `DELETE FROM return_cases WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM inspections WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM shipment_events WHERE shipment_id IN (SELECT id FROM shipments WHERE order_id = ANY($1))`, [orders]);
    await q(c, `DELETE FROM shipments WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM payments WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM order_events WHERE order_id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM orders WHERE id = ANY($1)`, [orders]);
    await q(c, `DELETE FROM quotations WHERE supplier_id = ANY($1) OR rfq_id IN (SELECT id FROM rfqs WHERE buyer_id = ANY($1))`, [orgs]);
    await q(c, `DELETE FROM rfqs WHERE buyer_id = ANY($1)`, [orgs]);
    await q(c, `DELETE FROM declaration_acceptances WHERE supplier_id = ANY($1)`, [orgs]);
    await q(c, `DELETE FROM harvests WHERE batch_id IN (SELECT id FROM batches WHERE supplier_id = ANY($1))`, [orgs]);
    await q(c, `DELETE FROM batches WHERE supplier_id = ANY($1)`, [orgs]);
    await q(c, `DELETE FROM products WHERE supplier_id = ANY($1)`, [orgs]);
    await q(c, `DELETE FROM supplier_quality_scores WHERE supplier_id = ANY($1)`, [orgs]);
    await q(c, `DELETE FROM config_audit_logs WHERE entity_id IN (SELECT id::text FROM fee_configs WHERE scope_ref = ANY($1)) OR user_id = ANY($2)`, [orgs, users]);
    await q(c, `DELETE FROM fee_configs WHERE scope_ref = ANY($1)`, [orgs]);
    await q(c, `UPDATE fee_configs SET created_by=NULL WHERE created_by = ANY($1)`, [users]);
    await q(c, `UPDATE fee_configs SET approved_by=NULL WHERE approved_by = ANY($1)`, [users]);
    await q(c, `UPDATE tax_rules SET created_by=NULL WHERE created_by = ANY($1)`, [users]);
    await q(c, `UPDATE settings SET updated_by=NULL WHERE updated_by = ANY($1)`, [users]);
    await q(c, `UPDATE ledger_journals SET created_by=NULL WHERE created_by = ANY($1)`, [users]);
    await q(c, `DELETE FROM users WHERE id = ANY($1)`, [users]);
    await q(c, `DELETE FROM organizations WHERE id = ANY($1)`, [orgs]);
    await audit(c, 'organizations', orgs.join(','), 'DELETE', { organizations: orgs.length, orders: orders.length }, null, req.user!.id, 'Purge data uji');
    return { organizations: orgs.length, orders: orders.length, evidence_files: files.length, storage_objects: 0, _files: files.map((f) => f.file_path) };
  });
  const { _files, ...out } = result as any;
  if (_files?.length) out.storage_objects = await deleteObjects(_files);
  res.json({ ...out, reconciliation: await reconcile(pool) });
}));
