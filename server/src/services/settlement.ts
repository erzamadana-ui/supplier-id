/**
 * SETTLEMENT — Payment Confirmations by Order.
 * delivered_at (bukti penerimaan sah) → confirmation_due_at = delivered_at + jendela (waktu server, UTC) →
 * konfirmasi pelanggan / auto-confirm (policy) / eskalasi → tepat satu PAYMENT TASK per suborder (settlement_key unik) →
 * maker mengajukan → checker menyetujui (≠ maker) → proses ke provider (idempotent) → PAID hanya dari bukti provider → ledger.
 * Status order, task, shipment, pembayaran pelanggan, sengketa, dan payout dipisahkan.
 */
import { Db, q, one, maybe, nextNo, tx, pool } from '../db';
import { bad, conflict, forbidden, money, AuthUser } from '../lib/http';
import { getSetting } from './config';
import { postJournal } from './ledger';
import { notify } from './notify';
import { transition } from './orders';
import { markLateTasks } from './fulfillment';

export type PtStatus = 'ON_HOLD' | 'CREATED' | 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REJECTED' | 'REVERSED' | 'CANCELLED';
const PT_ALLOWED: Record<PtStatus, PtStatus[]> = {
  ON_HOLD: ['CREATED', 'CANCELLED'],
  CREATED: ['PENDING_APPROVAL', 'ON_HOLD', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'ON_HOLD'],
  APPROVED: ['PROCESSING', 'ON_HOLD', 'FAILED'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: ['REVERSED'],
  FAILED: ['APPROVED', 'CANCELLED'],       // retry (inquiry/ulang) setelah ditinjau; bukan transfer baru otomatis
  REJECTED: ['CREATED'],                   // maker memperbaiki & mengajukan ulang
  REVERSED: [], CANCELLED: [],
};

export async function ptTransition(db: Db, id: string, to: PtStatus, actorId: string | null, note?: string, extraSet = '', data?: any) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1 FOR UPDATE', [id]);
  if (!PT_ALLOWED[t.status as PtStatus]?.includes(to)) throw conflict('INVALID_PAYMENT_TASK_TRANSITION', { from: t.status, to });
  const row = await one(db, `UPDATE payment_tasks SET status=$2, updated_at=now() ${extraSet} WHERE id=$1 RETURNING *`, [id, to]);
  await q(db, 'INSERT INTO payment_task_events(task_id, from_status, to_status, actor_id, note, data) VALUES ($1,$2,$3,$4,$5,$6)', [id, t.status, to, actorId, note ?? null, data ? JSON.stringify(data) : null]);
  return row;
}

/** Saldo hak mitra untuk satu order dari ledger (sumber kebenaran): Σ kredit − Σ debit SUPPLIER_PAYABLE (tanpa payout). */
export async function supplierNetForOrder(db: Db, orderId: string, supplierId: string) {
  const r = await one(db, `SELECT COALESCE(SUM(CASE WHEN side='CREDIT' THEN amount ELSE -amount END),0) AS net,
      COALESCE(SUM(CASE WHEN side='CREDIT' AND component='PRODUCT_VALUE' THEN amount ELSE 0 END),0) AS gross,
      COALESCE(SUM(CASE WHEN side='DEBIT' AND component IN ('RETURN_ADJUSTMENT') THEN amount ELSE 0 END),0) AS adjustments
    FROM ledger_entries WHERE order_id=$1 AND account='SUPPLIER_PAYABLE' AND party_id=$2 `, [orderId, supplierId]);
  return { net: money(Number(r.net)), gross: money(Number(r.gross)), adjustments: money(Number(r.adjustments)) };
}

/**
 * Buat tepat satu payment task per suborder (idempotent lewat settlement_key UNIQUE). Dipanggil saat order SETTLED.
 * Hold bila ada return case terbuka / hold_reason / pembayaran pelanggan belum PAID.
 */
export async function ensurePaymentTask(db: Db, orderId: string, trigger: 'BUYER_CONFIRM' | 'AUTO_CONFIRM' | 'OPS_CONFIRM' | 'DISPUTE_RESOLVED', actorId: string | null) {
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1', [orderId]);
  const key = `ORDER:${o.id}`;
  const existing = await maybe(db, 'SELECT * FROM payment_tasks WHERE settlement_key=$1', [key]);
  if (existing) return { task: existing, created: false };
  const sup = await one(db, 'SELECT * FROM organizations WHERE id=$1', [o.supplier_id]);
  const { net, gross, adjustments } = await supplierNetForOrder(db, o.id, o.supplier_id);
  const openCase = await maybe(db, `SELECT id FROM return_cases WHERE order_id=$1 AND status NOT IN ('CLOSED','REJECTED')`, [o.id]);
  const payment = await maybe(db, `SELECT status FROM payments WHERE order_id=$1 AND channel<>'ADDITIONAL' ORDER BY created_at DESC LIMIT 1`, [o.id]);
  let hold: string | null = null;
  if (openCase) hold = 'Sengketa/retur masih terbuka';
  else if (o.hold_reason) hold = o.hold_reason;
  else if (!payment || !['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status)) hold = 'Pembayaran pelanggan belum terverifikasi';
  else if (!sup.bank_account) hold = 'Rekening mitra belum terdaftar/terverifikasi';
  const status: PtStatus = net <= 0 ? 'CANCELLED' : hold ? 'ON_HOLD' : 'CREATED';
  const taskNo = await nextNo(db, 'paytask', 'PT');
  const eligibleQty = Number(o.accepted_quantity ?? o.quantity);
  const bank = sup.bank_account ? { bank_name: sup.bank_name, account: sup.bank_account, account_name: sup.bank_account_name, verified_at: sup.bank_verified_at } : null;
  try {
    const t = await one(db,
      `INSERT INTO payment_tasks(task_no, settlement_key, order_id, supplier_id, status, trigger, eligible_quantity, gross_amount, fee_amount, adjustment_amount, net_amount, bank_snapshot, hold_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11::jsonb,$12,$13) RETURNING *`,
      [taskNo, key, o.id, o.supplier_id, status, trigger, eligibleQty, gross, -adjustments, net, bank ? JSON.stringify(bank) : null, hold, actorId]);
    await q(db, 'INSERT INTO payment_task_events(task_id, from_status, to_status, actor_id, note) VALUES ($1,NULL,$2,$3,$4)', [t.id, status, actorId, `Dibuat oleh ${trigger}${hold ? ' — hold: ' + hold : ''}`]);
    await notify(db, { orgId: o.supplier_id, kind: 'PAYMENT_TASK', title: `Pembayaran ${o.order_no} ${status === 'ON_HOLD' ? 'ditahan' : 'dijadwalkan'}`, body: `Nilai neto Rp${net.toLocaleString('id-ID')}${hold ? ' — ' + hold : ''}`, link: `/supplier` });
    return { task: t, created: true };
  } catch (e: any) {
    if (e.code === '23505') return { task: await one(db, 'SELECT * FROM payment_tasks WHERE settlement_key=$1', [key]), created: false }; // balapan: sudah dibuat proses lain
    throw e;
  }
}

/** Bukti penerimaan sah → mulai jendela konfirmasi. Dipanggil saat OTP terverifikasi atau ops memverifikasi foto kurir. */
export async function startConfirmationWindow(db: Db, orderId: string, actorId: string | null, method: 'OTP' | 'PHOTO_VERIFIED') {
  const hours = Number(await getSetting(db, 'confirmation.window_hours', 24));
  const o = await one(db, `UPDATE orders SET delivered_at=COALESCE(delivered_at, now()), delivery_evidence_valid=TRUE,
      confirmation_due_at=COALESCE(delivered_at, now()) + ($2 || ' hours')::interval WHERE id=$1 RETURNING *`, [orderId, String(hours)]);
  await q(db, 'INSERT INTO order_events(order_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$2,$3,$4)', [o.id, o.status, actorId, `Bukti penerimaan sah (${method}); jendela konfirmasi ${hours} jam s.d. ${new Date(o.confirmation_due_at).toISOString()}`]);
  await notify(db, { orgId: o.buyer_id, kind: 'CONFIRM_DUE', title: `Konfirmasi penerimaan ${o.order_no}`, body: `Periksa barang dan konfirmasi paling lambat ${hours} jam. Tanpa respons, pesanan dianggap sesuai.`, link: `/orders/${o.id}` });
  return o;
}

/** Konfirmasi "sesuai" oleh pelanggan / sistem / ops: order SETTLED + payment task. */
export async function confirmReceived(db: Db, orderId: string, by: 'BUYER' | 'AUTO' | 'OPS', actorId: string | null) {
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (o.status !== 'ARRIVED_WAITING_INSPECTION') throw conflict('NOT_WAITING_CONFIRMATION', { status: o.status });
  const ship = await maybe(db, `SELECT * FROM shipments WHERE order_id=$1 AND type='DELIVERY' ORDER BY created_at DESC LIMIT 1`, [o.id]);
  const qty = Number(o.quantity);
  const insp = await one(db, `INSERT INTO inspections(order_id, shipment_id, buyer_id, inspector_id, decision, accepted_quantity, rejected_quantity, notes)
    VALUES ($1,$2,$3,$4,'ACCEPT',$5,0,$6) RETURNING *`, [o.id, ship?.id ?? null, o.buyer_id, actorId, qty, by === 'AUTO' ? 'Auto-confirm: jendela konfirmasi berakhir tanpa respons' : by === 'OPS' ? 'Dikonfirmasi operasional' : null]);
  if (ship) { await q(db, `UPDATE shipments SET status='RECEIVED' WHERE id=$1`, [ship.id]); await q(db, `UPDATE packages SET status='RECEIVED' WHERE shipment_id=$1 AND status='DELIVERED'`, [ship.id]); }
  let order = await transition(db, o.id, 'ACCEPTED', actorId, `Konfirmasi sesuai oleh ${by}`, `, inspected_at=now(), accepted_quantity=${qty}, rejected_quantity=0, confirmed_by='${by}', confirmation_at=now()`);
  order = await transition(db, o.id, 'SETTLED', actorId, 'Diterima penuh; hak mitra final', ', settled_at=now()');
  const pt = await ensurePaymentTask(db, o.id, by === 'BUYER' ? 'BUYER_CONFIRM' : by === 'AUTO' ? 'AUTO_CONFIRM' : 'OPS_CONFIRM', actorId);
  return { order, inspection: insp, payment_task: pt.task };
}

// ---------------- MAKER / CHECKER / PROSES ----------------
export async function submitPaymentTask(db: Db, id: string, u: AuthUser) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (!t.bank_snapshot) throw conflict('BANK_ACCOUNT_MISSING');
  const net = await supplierNetForOrder(db, t.order_id, t.supplier_id);
  if (Math.abs(net.net - Number(t.net_amount)) > 0.005) {
    await q(db, 'UPDATE payment_tasks SET net_amount=$2, adjustment_amount=$3 WHERE id=$1', [id, net.net, -net.adjustments]); // sinkron dengan ledger sebelum diajukan
  }
  return ptTransition(db, id, 'PENDING_APPROVAL', u.id, 'Diajukan maker', `, maker_id='${u.id}', submitted_at=now()`);
}
export async function approvePaymentTask(db: Db, id: string, u: AuthUser) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (t.maker_id === u.id) throw conflict('CHECKER_MUST_DIFFER_FROM_MAKER');
  const sla = Number(await getSetting(db, 'payout.sla_hours', 24));
  return ptTransition(db, id, 'APPROVED', u.id, 'Disetujui checker', `, checker_id='${u.id}', approved_at=now(), due_at=now() + interval '${sla} hours'`);
}
export async function rejectPaymentTask(db: Db, id: string, u: AuthUser, reason: string) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (t.maker_id === u.id) throw conflict('CHECKER_MUST_DIFFER_FROM_MAKER');
  return ptTransition(db, id, 'REJECTED', u.id, reason, `, checker_id='${u.id}', rejected_reason='${reason.replace(/'/g, "''")}'`);
}
export async function holdPaymentTask(db: Db, id: string, u: AuthUser, reason: string) {
  return ptTransition(db, id, 'ON_HOLD', u.id, reason, `, hold_reason='${reason.replace(/'/g, "''")}'`);
}
export async function releasePaymentTask(db: Db, id: string, u: AuthUser) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  const openCase = await maybe(db, `SELECT id FROM return_cases WHERE order_id=$1 AND status NOT IN ('CLOSED','REJECTED')`, [t.order_id]);
  if (openCase) throw conflict('DISPUTE_STILL_OPEN');
  const net = await supplierNetForOrder(db, t.order_id, t.supplier_id);
  return ptTransition(db, id, 'CREATED', u.id, 'Hold dilepas', `, hold_reason=NULL, net_amount=${net.net}, adjustment_amount=${-net.adjustments}`);
}

/** Adaptor provider payout. NONE = belum terkonfigurasi (gagal jelas). MOCK = sandbox (ditandai is_sandbox). */
interface PayoutProvider { name: string; sandbox: boolean; transfer(req: { idempotencyKey: string; amount: number; bank: any; reference: string }): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; ref: string; raw: any }>; inquiry(ref: string): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED'; raw: any }> }
const mockState = new Map<string, string>();
const providers: Record<string, PayoutProvider> = {
  MOCK: {
    name: 'MOCK', sandbox: true,
    async transfer(r) { mockState.set(r.idempotencyKey, 'PROCESSING'); return { status: 'PROCESSING', ref: `MOCK-PO-${r.idempotencyKey.slice(-8)}`, raw: { sandbox: true } }; },
    async inquiry(ref) { return { status: 'PAID', raw: { sandbox: true, ref } }; },
  },
};
async function getProvider(db: Db): Promise<PayoutProvider | null> {
  const name = String(await getSetting(db, 'payout.provider', 'NONE')).toUpperCase();
  if (name === 'NONE') return null;
  const p = providers[name];
  if (!p) throw conflict('PAYOUT_PROVIDER_UNKNOWN', { provider: name });
  return p;
}

/**
 * PROSES transfer (maker, setelah APPROVED). Idempotent: payouts.idempotency_key = settlement_key (UNIQUE) →
 * pemanggilan ganda/timeout tidak menghasilkan transfer baru. PAID hanya dari hasil provider (sinkron atau inquiry/webhook).
 */
export async function processPaymentTask(db: Db, id: string, u: AuthUser) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1 FOR UPDATE', [id]);
  if (t.status !== 'APPROVED') throw conflict('TASK_NOT_APPROVED', { status: t.status });
  if (t.checker_id === u.id && (await getSetting(db, 'payout.maker_checker_required', true))) throw conflict('PROCESSOR_MUST_DIFFER_FROM_CHECKER');
  const provider = await getProvider(db);
  if (!provider) throw conflict('PAYOUT_PROVIDER_NOT_CONFIGURED', 'Setting payout.provider = NONE. Transfer harus dilakukan manual lalu dicatat lewat /mark-paid dengan bukti bank.');
  const existing = await maybe(db, 'SELECT * FROM payouts WHERE idempotency_key=$1', [t.settlement_key]);
  if (existing) return { task: t, payout: existing, duplicate: true };
  const payoutNo = await nextNo(db, 'payout', 'PO');
  const payout = await one(db, `INSERT INTO payouts(payout_no, supplier_id, amount, order_ids, status, provider, idempotency_key, created_by, is_sandbox)
    VALUES ($1,$2,$3,$4::jsonb,'PROCESSING',$5,$6,$7,$8) RETURNING *`, [payoutNo, t.supplier_id, t.net_amount, JSON.stringify([t.order_id]), provider.name, t.settlement_key, u.id, provider.sandbox]);
  const task = await ptTransition(db, id, 'PROCESSING', u.id, `Dikirim ke provider ${provider.name}`, `, payout_id='${payout.id}', processing_at=now()`);
  let res;
  try { res = await provider.transfer({ idempotencyKey: t.settlement_key, amount: Number(t.net_amount), bank: t.bank_snapshot, reference: t.task_no }); }
  catch (e: any) { // timeout/jaringan: JANGAN ulang sebagai transfer baru — tetap PROCESSING, selesaikan lewat inquiry
    await q(db, `UPDATE payouts SET provider_response=$2::jsonb, last_inquiry_at=now() WHERE id=$1`, [payout.id, JSON.stringify({ error: String(e?.message ?? e) })]);
    return { task, payout: await one(db, 'SELECT * FROM payouts WHERE id=$1', [payout.id]), pending_inquiry: true };
  }
  await q(db, `UPDATE payouts SET bank_ref=$2, provider_response=$3::jsonb WHERE id=$1`, [payout.id, res.ref, JSON.stringify(res.raw)]);
  if (res.status === 'PAID') return { task: await markPaid(db, id, u.id, res.ref, 'provider-sync'), payout: await one(db, 'SELECT * FROM payouts WHERE id=$1', [payout.id]) };
  if (res.status === 'FAILED') return { task: await markFailed(db, id, u.id, 'Provider menolak transfer'), payout: await one(db, 'SELECT * FROM payouts WHERE id=$1', [payout.id]) };
  return { task: await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]), payout: await one(db, 'SELECT * FROM payouts WHERE id=$1', [payout.id]) };
}

/** PAID: posting jurnal payout (DR SUPPLIER_PAYABLE / CR CASH) — hanya dari bukti provider atau rekonsiliasi bank. */
export async function markPaid(db: Db, id: string, actorId: string | null, providerRef: string, source: string) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1 FOR UPDATE', [id]);
  if (t.status === 'PAID') return t;
  const o = await one(db, 'SELECT order_no FROM orders WHERE id=$1', [t.order_id]);
  const jid = await postJournal(db, { type: 'SUPPLIER_PAYOUT', orderId: t.order_id, reference: t.task_no, memo: `Payout ${source} ref ${providerRef}`, createdBy: actorId }, [
    { account: 'SUPPLIER_PAYABLE', component: 'SUPPLIER_PAYOUT', side: 'DEBIT', amount: Number(t.net_amount), partyType: 'SUPPLIER', partyId: t.supplier_id, memo: o.order_no },
    { account: 'CASH', component: 'CASH_OUT', side: 'CREDIT', amount: Number(t.net_amount), partyType: 'SUPPLIER', partyId: t.supplier_id, memo: o.order_no },
  ]);
  if (t.payout_id) await q(db, `UPDATE payouts SET status='PAID', paid_at=now(), journal_id=$2, bank_ref=COALESCE(bank_ref,$3) WHERE id=$1`, [t.payout_id, jid, providerRef]);
  const row = await ptTransition(db, id, 'PAID', actorId, `Dibayar (${source}) ref ${providerRef}`, `, paid_at=now(), provider_ref='${providerRef.replace(/'/g, "''")}'`);
  await notify(db, { orgId: t.supplier_id, kind: 'PAYOUT_PAID', title: `Pembayaran ${o.order_no} terkirim`, body: `Rp${Number(t.net_amount).toLocaleString('id-ID')} ref ${providerRef}`, link: '/supplier' });
  return row;
}
export async function markFailed(db: Db, id: string, actorId: string | null, reason: string) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (t.payout_id) await q(db, `UPDATE payouts SET status='FAILED', failure_reason=$2 WHERE id=$1`, [t.payout_id, reason]);
  await q(db, `INSERT INTO escalations(order_id, kind, reason) VALUES ($1,'PAYOUT_FAILED',$2)`, [t.order_id, reason]);
  return ptTransition(db, id, 'FAILED', actorId, reason, `, failure_reason='${reason.replace(/'/g, "''")}'`);
}
/** Transfer manual (provider NONE): finance checker mencatat bukti bank → PAID. */
export async function markPaidManual(db: Db, id: string, u: AuthUser, bankRef: string) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (!['APPROVED', 'PROCESSING'].includes(t.status)) throw conflict('TASK_NOT_APPROVED', { status: t.status });
  if (t.maker_id === u.id) throw conflict('CHECKER_MUST_DIFFER_FROM_MAKER');
  if (!t.payout_id) {
    const payoutNo = await nextNo(db, 'payout', 'PO');
    const p = await one(db, `INSERT INTO payouts(payout_no, supplier_id, amount, order_ids, status, provider, idempotency_key, bank_ref, created_by, is_sandbox) VALUES ($1,$2,$3,$4::jsonb,'PROCESSING','MANUAL',$5,$6,$7,FALSE) RETURNING *`,
      [payoutNo, t.supplier_id, t.net_amount, JSON.stringify([t.order_id]), t.settlement_key, bankRef, u.id]);
    await ptTransition(db, id, 'PROCESSING', u.id, 'Transfer manual dicatat', `, payout_id='${p.id}', processing_at=now()`);
  }
  return markPaid(db, id, u.id, bankRef, 'manual-bank');
}
/** Inquiry status ke provider untuk task PROCESSING (dipakai job & tombol). */
export async function inquirePaymentTask(db: Db, id: string, actorId: string | null) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (t.status !== 'PROCESSING') return t;
  const payout = await one(db, 'SELECT * FROM payouts WHERE id=$1', [t.payout_id]);
  if (payout.provider === 'MANUAL') return t;
  const provider = await getProvider(db);
  if (!provider || provider.name !== payout.provider) return t;
  const r = await provider.inquiry(payout.bank_ref ?? payout.idempotency_key);
  await q(db, `UPDATE payouts SET inquiry_count=inquiry_count+1, last_inquiry_at=now(), provider_response=$2::jsonb WHERE id=$1`, [payout.id, JSON.stringify(r.raw)]);
  if (r.status === 'PAID') return markPaid(db, id, actorId, payout.bank_ref ?? payout.idempotency_key, 'provider-inquiry');
  if (r.status === 'FAILED') return markFailed(db, id, actorId, 'Provider: gagal (inquiry)');
  return t;
}
/** REVERSAL: membatalkan klaim final pembayaran (entri pembalik), masuk rekonsiliasi & eskalasi. */
export async function reversePaymentTask(db: Db, id: string, u: AuthUser, reason: string) {
  const t = await one(db, 'SELECT * FROM payment_tasks WHERE id=$1', [id]);
  if (t.status !== 'PAID') throw conflict('TASK_NOT_PAID');
  const o = await one(db, 'SELECT order_no FROM orders WHERE id=$1', [t.order_id]);
  await postJournal(db, { type: 'PAYOUT_REVERSAL', orderId: t.order_id, reference: t.task_no, memo: reason, createdBy: u.id }, [
    { account: 'CASH', component: 'CASH_IN', side: 'DEBIT', amount: Number(t.net_amount), partyType: 'SUPPLIER', partyId: t.supplier_id, memo: o.order_no },
    { account: 'SUPPLIER_PAYABLE', component: 'PAYOUT_REVERSAL', side: 'CREDIT', amount: Number(t.net_amount), partyType: 'SUPPLIER', partyId: t.supplier_id, memo: o.order_no },
  ]);
  if (t.payout_id) await q(db, `UPDATE payouts SET status='REVERSED', reversed_at=now(), failure_reason=$2 WHERE id=$1`, [t.payout_id, reason]);
  await q(db, `INSERT INTO escalations(order_id, kind, reason) VALUES ($1,'PAYOUT_FAILED',$2)`, [t.order_id, `Reversal: ${reason}`]);
  return ptTransition(db, id, 'REVERSED', u.id, reason, `, reversed_at=now(), reversal_reason='${reason.replace(/'/g, "''")}'`);
}

// ---------------- JOBS (durable: state di DB, idempotent, dicatat di job_runs) ----------------
export async function runJobs(trigger = 'cron') {
  const started = Date.now();
  const run = await one(pool, `INSERT INTO job_runs(job_name) VALUES ($1) RETURNING id`, [`all:${trigger}`]);
  const result: Record<string, any> = {};
  try {
    result.expired_payments = await tx((c) => expireUnpaid(c));
    result.late_tasks = await tx((c) => markLateTasks(c));
    result.confirmations = await tx((c) => processConfirmations(c));
    result.payout_inquiries = await tx((c) => inquireProcessing(c));
    await q(pool, `UPDATE job_runs SET finished_at=now(), result=$2::jsonb WHERE id=$1`, [run.id, JSON.stringify({ ...result, ms: Date.now() - started })]);
    return result;
  } catch (e: any) {
    await q(pool, `UPDATE job_runs SET finished_at=now(), result=$2::jsonb, error=$3 WHERE id=$1`, [run.id, JSON.stringify(result), String(e?.stack ?? e)]);
    throw e;
  }
}

/** Pembayaran kedaluwarsa → order CANCELLED, reservasi stok dilepas (pelanggan dapat memesan ulang). */
async function expireUnpaid(db: Db) {
  const rows = await q(db, `SELECT id, batch_id, quantity, order_group_id FROM orders WHERE status='PENDING_PAYMENT' AND payment_due_at IS NOT NULL AND payment_due_at < now() FOR UPDATE SKIP LOCKED`);
  for (const o of rows) {
    await transition(db, o.id, 'CANCELLED', null, 'Pembayaran kedaluwarsa (job)', ', cancelled_at=now()');
    await q(db, `UPDATE batches SET available_quantity=available_quantity+$2, status=CASE WHEN status='SOLD_OUT' THEN 'READY_FOR_ORDER' ELSE status END WHERE id=$1`, [o.batch_id, o.quantity]);
    await q(db, `UPDATE payments SET status='EXPIRED' WHERE order_id=$1 AND status='PENDING'`, [o.id]);
    if (o.order_group_id) await q(db, `UPDATE order_groups SET status='EXPIRED' WHERE id=$1 AND status='PENDING_PAYMENT'`, [o.order_group_id]);
  }
  return rows.length;
}

/** Jendela konfirmasi berakhir: auto-confirm sesuai policy & syarat; selain itu eskalasi (dana tidak dilepas). */
async function processConfirmations(db: Db) {
  const enabled = await getSetting(db, 'confirmation.auto_confirm_enabled', false);
  const requireEvidence = await getSetting(db, 'confirmation.require_valid_evidence', true);
  const due = await q(db, `SELECT o.*, g.auto_confirm_notice_accepted_at FROM orders o LEFT JOIN order_groups g ON g.id=o.order_group_id
    WHERE o.status='ARRIVED_WAITING_INSPECTION' AND o.confirmation_due_at IS NOT NULL AND o.confirmation_due_at < now() AND o.needs_ops_review=FALSE FOR UPDATE OF o SKIP LOCKED`);
  let auto = 0, escalated = 0;
  for (const o of due) {
    const payment = await maybe(db, `SELECT status FROM payments WHERE order_id=$1 AND channel<>'ADDITIONAL' ORDER BY created_at DESC LIMIT 1`, [o.id]);
    const openCase = await maybe(db, `SELECT id FROM return_cases WHERE order_id=$1 AND status NOT IN ('CLOSED','REJECTED')`, [o.id]);
    const ok = enabled && (!requireEvidence || o.delivery_evidence_valid) && !!o.auto_confirm_notice_accepted_at && payment && ['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status) && !openCase && !o.hold_reason;
    if (ok) { await confirmReceived(db, o.id, 'AUTO', null); auto++; }
    else {
      const reasons = [!enabled && 'policy nonaktif', requireEvidence && !o.delivery_evidence_valid && 'bukti penerimaan belum valid', !o.auto_confirm_notice_accepted_at && 'pelanggan tidak diberitahu kebijakan saat checkout', !(payment && ['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status)) && 'pembayaran belum terverifikasi', openCase && 'sengketa terbuka', o.hold_reason && `hold: ${o.hold_reason}`].filter(Boolean).join('; ');
      await q(db, `UPDATE orders SET needs_ops_review=TRUE WHERE id=$1`, [o.id]);
      await q(db, `INSERT INTO escalations(order_id, kind, reason) VALUES ($1,'CONFIRMATION_OVERDUE',$2)`, [o.id, `Jendela konfirmasi berakhir; auto-confirm tidak memenuhi syarat: ${reasons}`]);
      escalated++;
    }
  }
  return { auto, escalated };
}

async function inquireProcessing(db: Db) {
  const rows = await q(db, `SELECT id FROM payment_tasks WHERE status='PROCESSING' AND processing_at < now() - interval '1 minute'`);
  let n = 0;
  for (const r of rows) { await inquirePaymentTask(db, r.id, null); n++; }
  return n;
}

export async function assertFinanceRole(u: AuthUser, kind: 'make' | 'check' | 'process') {
  const perm = kind === 'make' ? 'payouts.make' : kind === 'check' ? 'payouts.check' : 'payouts.process';
  const perms = u.permissions ?? [];
  if (!(perms.includes('*') || perms.includes(perm))) throw forbidden(`PERMISSION_REQUIRED:${perm}`);
}
