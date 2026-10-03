/**
 * FULFILLMENT — task inbox mitra, tahap kerja, QC (timbang berat aktual), packing → paket + label, scan.
 * Tahap: ACCEPTANCE → (PRODUCTION | PICKING) → QC → PACKING → HANDOVER. Tahap berikutnya hanya dibuat setelah syarat tahap sebelumnya terpenuhi.
 * State order tetap terpisah (PAID → PROCESSING → PACKING → READY_FOR_PICKUP → PICKED_UP …).
 */
import crypto from 'node:crypto';
import { Db, q, one, maybe, nextNo } from '../db';
import { bad, conflict, forbidden, money, AuthUser } from '../lib/http';
import { getSetting } from './config';
import { transition } from './orders';
import { notify } from './notify';
import { postJournal, postRefundPaid } from './ledger';

export type Stage = 'ACCEPTANCE' | 'PRODUCTION' | 'PICKING' | 'QC' | 'PACKING' | 'HANDOVER';
export type TaskStatus = 'NEW' | 'AWAITING_RESPONSE' | 'IN_PROGRESS' | 'NEEDS_ACTION' | 'LATE' | 'DONE' | 'REJECTED' | 'CANCELLED';

const TASK_ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  NEW: ['IN_PROGRESS', 'LATE', 'CANCELLED', 'DONE'],
  AWAITING_RESPONSE: ['DONE', 'REJECTED', 'LATE', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'NEEDS_ACTION', 'LATE', 'CANCELLED'],
  NEEDS_ACTION: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  LATE: ['IN_PROGRESS', 'DONE', 'REJECTED', 'CANCELLED'],
  DONE: [], REJECTED: [], CANCELLED: [],
};

export async function taskTransition(db: Db, taskId: string, to: TaskStatus, actorId: string | null, note?: string, extraSet = '', data?: any) {
  const t = await one(db, 'SELECT * FROM fulfillment_tasks WHERE id=$1 FOR UPDATE', [taskId]);
  if (!TASK_ALLOWED[t.status as TaskStatus]?.includes(to)) throw conflict('INVALID_TASK_TRANSITION', { from: t.status, to });
  const row = await one(db, `UPDATE fulfillment_tasks SET status=$2, updated_at=now() ${extraSet} WHERE id=$1 RETURNING *`, [taskId, to]);
  await q(db, 'INSERT INTO task_events(task_id, from_status, to_status, actor_id, note, data) VALUES ($1,$2,$3,$4,$5,$6)', [taskId, t.status, to, actorId, note ?? null, data ? JSON.stringify(data) : null]);
  return row;
}

async function createTask(db: Db, o: any, stage: Stage, status: TaskStatus, a: { deadline?: Date | null; dependsOn?: string | null; instructions?: string; priority?: number; weightKg?: number | null }) {
  const taskNo = await nextNo(db, 'task', 'TSK');
  const t = await one(db,
    `INSERT INTO fulfillment_tasks(task_no, order_id, supplier_id, stage, status, quantity, unit, weight_kg, deadline, priority, instructions, depends_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [taskNo, o.id, o.supplier_id, stage, status, o.quantity, o.unit, a.weightKg ?? o.weight_kg ?? null, a.deadline ?? null, a.priority ?? 3, a.instructions ?? null, a.dependsOn ?? null]);
  await q(db, 'INSERT INTO task_events(task_id, from_status, to_status, note) VALUES ($1,NULL,$2,$3)', [t.id, status, `Task ${stage} dibuat`]);
  return t;
}

/** Dipanggil saat pembayaran pelanggan terverifikasi (PAID): task ACCEPTANCE untuk mitra. */
export async function createAcceptanceTask(db: Db, order: any) {
  const existing = await maybe(db, `SELECT id FROM fulfillment_tasks WHERE order_id=$1 AND stage='ACCEPTANCE'`, [order.id]);
  if (existing) return existing;
  const hours = Number(await getSetting(db, 'supplier.response_hours', 12));
  const t = await createTask(db, order, 'ACCEPTANCE', 'AWAITING_RESPONSE', {
    deadline: new Date(Date.now() + hours * 3600_000), priority: 2,
    instructions: `Terima atau tolak pesanan ${order.order_no}. Jadwal pickup: ${order.promised_pickup_at ? new Date(order.promised_pickup_at).toISOString() : '-'}`,
  });
  await notify(db, { orgId: order.supplier_id, kind: 'TASK_NEW', title: `Pesanan baru ${order.order_no}`, body: `Respons paling lambat ${hours} jam`, link: `/supplier/tasks/${t.id}` });
  return t;
}

async function assertSupplierTask(db: Db, taskId: string, u: AuthUser) {
  const t = await one(db, 'SELECT * FROM fulfillment_tasks WHERE id=$1', [taskId]);
  if (u.role === 'SUPPLIER' && t.supplier_id !== u.orgId) throw forbidden();
  if (!['SUPPLIER', 'ADMIN'].includes(u.role)) throw forbidden();
  return t;
}

/** Mitra MENERIMA pesanan → order PROCESSING; task tahap berikutnya (PRODUCTION untuk preorder/panen, PICKING untuk ready stock). */
export async function acceptOrder(db: Db, taskId: string, u: AuthUser, a: { ready_at?: string | null; note?: string }) {
  const t = await assertSupplierTask(db, taskId, u);
  if (t.stage !== 'ACCEPTANCE') throw conflict('NOT_ACCEPTANCE_TASK');
  const o = await one(db, 'SELECT o.*, b.sale_mode, b.type AS batch_type FROM orders o JOIN batches b ON b.id=o.batch_id WHERE o.id=$1 FOR UPDATE', [t.order_id]);
  if (o.status !== 'PAID') throw conflict('ORDER_NOT_PAID', { status: o.status });
  await taskTransition(db, t.id, 'DONE', u.id, a.note ?? 'Pesanan diterima mitra', `, done_at=now(), ready_at=${a.ready_at ? `'${new Date(a.ready_at).toISOString()}'` : 'NULL'}, assignee_id='${u.id}'`);
  const order = await transition(db, o.id, 'PROCESSING', u.id, 'Mitra menerima pesanan', `, supplier_accepted_at=now()${a.ready_at ? `, ready_at='${new Date(a.ready_at).toISOString()}'` : ''}`);
  const needsProduction = o.sale_mode === 'PREORDER' || o.batch_type === 'HARVEST';
  const next = await createTask(db, order, needsProduction ? 'PRODUCTION' : 'PICKING', 'NEW', {
    deadline: order.promised_pickup_at ? new Date(new Date(order.promised_pickup_at).getTime() - 6 * 3600_000) : null, dependsOn: t.id,
    instructions: needsProduction ? 'Panen/produksi sesuai kuantitas pesanan, lalu lanjut QC.' : 'Siapkan barang dari stok sesuai kuantitas pesanan, lalu lanjut QC.',
  });
  await notify(db, { orgId: order.buyer_id, kind: 'ORDER_ACCEPTED', title: `Pesanan ${order.order_no} diterima mitra`, body: 'Mitra mulai menyiapkan barang Anda', link: `/orders/${order.id}` });
  return { task: t, order, next };
}

/** Mitra MENOLAK pesanan → eskalasi ops (batal+refund atau pesan ulang). Alokasi tidak digandakan. */
export async function rejectOrder(db: Db, taskId: string, u: AuthUser, reason: string) {
  const t = await assertSupplierTask(db, taskId, u);
  if (t.stage !== 'ACCEPTANCE') throw conflict('NOT_ACCEPTANCE_TASK');
  if (!reason || reason.length < 3) throw bad('REASON_REQUIRED');
  await taskTransition(db, t.id, 'REJECTED', u.id, reason, `, reason='${reason.replace(/'/g, "''")}', assignee_id='${u.id}'`);
  await q(db, `UPDATE orders SET needs_ops_review=TRUE, hold_reason=$2 WHERE id=$1`, [t.order_id, `Mitra menolak: ${reason}`]);
  const esc = await one(db, `INSERT INTO escalations(order_id, task_id, kind, reason) VALUES ($1,$2,'SUPPLIER_REJECTED',$3) RETURNING *`, [t.order_id, t.id, reason]);
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1', [t.order_id]);
  await notify(db, { orgId: o.buyer_id, kind: 'ORDER_REJECTED', title: `Pesanan ${o.order_no} tidak dapat dipenuhi mitra`, body: 'Tim Supplier-ID akan menghubungi Anda untuk pengembalian dana atau pengganti.', link: `/orders/${o.id}` });
  return { task: t, escalation: esc };
}

export async function startTask(db: Db, taskId: string, u: AuthUser) {
  const t = await assertSupplierTask(db, taskId, u);
  if (t.depends_on) {
    const dep = await one(db, 'SELECT status FROM fulfillment_tasks WHERE id=$1', [t.depends_on]);
    if (dep.status !== 'DONE') throw conflict('DEPENDENCY_NOT_DONE');
  }
  return taskTransition(db, t.id, 'IN_PROGRESS', u.id, 'Mulai dikerjakan', `, started_at=COALESCE(started_at, now()), assignee_id='${u.id}'`);
}

/** Selesai PRODUCTION/PICKING → task QC dibuat. */
export async function completeWorkTask(db: Db, taskId: string, u: AuthUser, result: any = {}) {
  const t = await assertSupplierTask(db, taskId, u);
  if (!['PRODUCTION', 'PICKING'].includes(t.stage)) throw conflict('NOT_WORK_TASK', { stage: t.stage });
  if (t.status === 'NEW' || t.status === 'LATE') await taskTransition(db, t.id, 'IN_PROGRESS', u.id, 'Mulai', `, started_at=COALESCE(started_at, now()), assignee_id='${u.id}'`);
  const done = await taskTransition(db, t.id, 'DONE', u.id, 'Selesai', `, done_at=now(), result=$3::jsonb`.replace('$3', `'${JSON.stringify(result).replace(/'/g, "''")}'`));
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1', [t.order_id]);
  const qc = await createTask(db, o, 'QC', 'NEW', { deadline: t.deadline, dependsOn: t.id, priority: 2, instructions: 'Timbang berat aktual, periksa kondisi sesuai deklarasi, unggah foto QC.' });
  return { task: done, next: qc };
}

/**
 * QC: catat berat/kuantitas aktual, suhu, lulus/gagal + foto (evidence owner_type QC). Lulus → task PACKING.
 * Berat aktual vs toleransi: di dalam toleransi → tidak ada perubahan harga; kurang → refund selisih (mitra menanggung);
 * lebih dari toleransi → PENDING_CUSTOMER (pelanggan setuju bayar selisih atau minta dikemas sesuai toleransi). Tidak ada penarikan dana diam-diam.
 */
export async function recordQc(db: Db, taskId: string, u: AuthUser, a: { measured_quantity?: number; measured_weight_kg?: number; measured_temperature_c?: number; grade?: string; passed: boolean; reject_reason?: string; notes?: string }) {
  const t = await assertSupplierTask(db, taskId, u);
  if (t.stage !== 'QC') throw conflict('NOT_QC_TASK');
  if (!['NEW', 'IN_PROGRESS', 'NEEDS_ACTION', 'LATE'].includes(t.status)) throw conflict('TASK_NOT_OPEN', { status: t.status });
  const o = await one(db, 'SELECT o.*, b.weight_tolerance_pct, b.expected_weight_kg, b.quantity AS batch_quantity FROM orders o JOIN batches b ON b.id=o.batch_id WHERE o.id=$1 FOR UPDATE', [t.order_id]);
  const photos = await q(db, `SELECT id FROM evidence_files WHERE order_id=$1 AND owner_type='QC'`, [o.id]);
  if (!photos.length) throw bad('QC_PHOTO_REQUIRED', 'Unggah minimal 1 foto QC');
  if (!a.passed && !a.reject_reason) throw bad('REJECT_REASON_REQUIRED');
  const rec = await one(db,
    `INSERT INTO qc_records(task_id, order_id, batch_id, supplier_id, inspector_id, measured_quantity, measured_weight_kg, measured_temperature_c, grade, passed, reject_reason, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [t.id, o.id, o.batch_id, o.supplier_id, u.id, a.measured_quantity ?? null, a.measured_weight_kg ?? null, a.measured_temperature_c ?? null, a.grade ?? null, a.passed, a.reject_reason ?? null, a.notes ?? null]);
  if (t.status === 'NEW' || t.status === 'LATE' || t.status === 'NEEDS_ACTION') await taskTransition(db, t.id, 'IN_PROGRESS', u.id, 'QC dilakukan', `, started_at=COALESCE(started_at, now()), assignee_id='${u.id}'`);
  if (!a.passed) {
    await taskTransition(db, t.id, 'NEEDS_ACTION', u.id, `QC gagal: ${a.reject_reason}`, `, reason='${(a.reject_reason ?? '').replace(/'/g, "''")}'`);
    await q(db, `INSERT INTO escalations(order_id, task_id, kind, reason) VALUES ($1,$2,'QC_FAILED',$3)`, [o.id, t.id, a.reject_reason]);
    return { qc: rec, task: await one(db, 'SELECT * FROM fulfillment_tasks WHERE id=$1', [t.id]), weight_adjustment: null };
  }
  // ---- berat aktual vs toleransi (hanya bila berat diukur & order berbasis berat) ----
  let wa: any = { status: 'NONE' };
  if (a.measured_weight_kg != null && Number(o.weight_kg) > 0) {
    const expected = Number(o.weight_kg), actual = Number(a.measured_weight_kg), tol = Number(o.weight_tolerance_pct ?? 2);
    const deltaPct = ((actual - expected) / expected) * 100;
    const unitValuePerKg = Number(o.product_value) / expected;
    const deltaValue = money((actual - expected) * unitValuePerKg);
    if (Math.abs(deltaPct) <= tol) wa = { status: 'WITHIN_TOLERANCE', expected, actual, tolerance_pct: tol, delta_pct: money(deltaPct), delta_value: 0 };
    else if (actual < expected) {
      wa = { status: 'SHORTAGE_REFUND', expected, actual, tolerance_pct: tol, delta_pct: money(deltaPct), delta_value: deltaValue };
      await postWeightShortage(db, o, Math.abs(deltaValue), u.id);
    } else {
      wa = { status: 'PENDING_CUSTOMER', expected, actual, tolerance_pct: tol, delta_pct: money(deltaPct), delta_value: deltaValue };
      await q(db, `INSERT INTO escalations(order_id, task_id, kind, reason) VALUES ($1,$2,'WEIGHT_VARIANCE',$3)`, [o.id, t.id, `Berat aktual ${actual} kg > estimasi ${expected} kg (+${money(deltaPct)}%)`]);
      await notify(db, { orgId: o.buyer_id, kind: 'WEIGHT_VARIANCE', title: `Berat aktual pesanan ${o.order_no} melebihi estimasi`, body: `Setujui tambahan Rp${deltaValue.toLocaleString('id-ID')} atau minta dikemas sesuai toleransi.`, link: `/orders/${o.id}` });
    }
    await q(db, `UPDATE orders SET actual_weight_kg=$2, weight_adjustment=$3::jsonb WHERE id=$1`, [o.id, actual, JSON.stringify(wa)]);
  }
  const done = await taskTransition(db, t.id, 'DONE', u.id, 'QC lulus', `, done_at=now(), result='${JSON.stringify({ qc_record_id: rec.id, weight_adjustment: wa }).replace(/'/g, "''")}'::jsonb`);
  const packing = await createTask(db, o, 'PACKING', wa.status === 'PENDING_CUSTOMER' ? 'NEEDS_ACTION' : 'NEW', {
    deadline: t.deadline, dependsOn: t.id, priority: 2, weightKg: a.measured_weight_kg ?? null,
    instructions: wa.status === 'PENDING_CUSTOMER' ? 'Menunggu keputusan pelanggan atas selisih berat sebelum packing.' : 'Kemas sesuai kebutuhan penyimpanan, buat paket & cetak label.',
  });
  return { qc: rec, task: done, next: packing, weight_adjustment: wa };
}

/** Kekurangan berat di luar toleransi → refund prorata ke pelanggan, mitra menanggung (RESELLER: hak mitra dipotong proporsional harga beli, sisa dari margin). */
async function postWeightShortage(db: Db, o: any, refund: number, actorId: string) {
  if (refund <= 0) return;
  const entries: any[] = [];
  if (o.trade_model === 'RESELLER' && Number(o.purchase_value) > 0) {
    const supplierPart = money(refund * (Number(o.purchase_value) / Number(o.product_value)));
    entries.push({ account: 'SUPPLIER_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: supplierPart, partyType: 'SUPPLIER', partyId: o.supplier_id, memo: 'Potongan hak mitra: kekurangan berat' });
    entries.push({ account: 'RESELLER_MARGIN_REVENUE', component: 'RESELLER_MARGIN', side: 'DEBIT', amount: money(refund - supplierPart), partyType: 'PLATFORM', memo: 'Pembalikan margin reseller: kekurangan berat' });
  } else {
    entries.push({ account: 'SUPPLIER_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: refund, partyType: 'SUPPLIER', partyId: o.supplier_id, memo: 'Potongan hak mitra: kekurangan berat' });
  }
  entries.push({ account: 'REFUND_PAYABLE', component: 'REFUND', side: 'CREDIT', amount: refund, partyType: 'BUYER', partyId: o.buyer_id, memo: 'Refund selisih berat aktual' });
  const jid = await postJournal(db, { type: 'WEIGHT_ADJUSTMENT', orderId: o.id, reference: o.order_no, createdBy: actorId, memo: 'Kekurangan berat aktual di luar toleransi' }, entries);
  await q(db, `INSERT INTO financial_adjustments(order_id, adjustment_type, components, refund_to_buyer, supplier_deduction, journal_id, created_by) VALUES ($1,'WEIGHT_SHORTAGE','{}'::jsonb,$2,$3,$4,$5)`, [o.id, refund, refund, jid, actorId]);
  await postRefundPaid(db, o, refund);
  await q(db, `UPDATE payments SET status='PARTIALLY_REFUNDED' WHERE order_id=$1 AND status='PAID'`, [o.id]);
}

/** Keputusan pelanggan atas kelebihan berat: APPROVE (bayar selisih — pembayaran tambahan dicatat) atau DECLINE (mitra kemas ulang sesuai toleransi). */
export async function decideWeightVariance(db: Db, orderId: string, u: AuthUser, decision: 'APPROVE' | 'DECLINE') {
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (u.role === 'BUYER' && o.buyer_id !== u.orgId) throw forbidden();
  const wa = o.weight_adjustment;
  if (!wa || wa.status !== 'PENDING_CUSTOMER') throw conflict('NO_PENDING_WEIGHT_VARIANCE');
  const packing = await one(db, `SELECT * FROM fulfillment_tasks WHERE order_id=$1 AND stage='PACKING'`, [orderId]);
  if (decision === 'APPROVE') {
    const extra = Number(wa.delta_value);
    // Pembayaran tambahan: mock/sandbox (gateway nyata menggantikan ini). Dicatat sebagai payment terpisah — tidak diam-diam.
    const pay = await one(db, `INSERT INTO payments(order_id, order_group_id, provider, channel, amount, provider_fee, status, provider_ref, paid_at, is_sandbox)
      VALUES ($1,$2,'MOCK_GATEWAY','ADDITIONAL',$3,0,'PAID',$4,now(),TRUE) RETURNING *`, [o.id, o.order_group_id, extra, `MOCK-ADD-${Date.now()}`]);
    const entries: any[] = [{ account: 'CASH', component: 'CASH_IN', side: 'DEBIT', amount: extra, partyType: 'BUYER', partyId: o.buyer_id, memo: 'Pembayaran tambahan selisih berat' }];
    if (o.trade_model === 'RESELLER' && Number(o.purchase_value) > 0) {
      const supplierPart = money(extra * (Number(o.purchase_value) / Number(o.product_value)));
      entries.push({ account: 'SUPPLIER_PAYABLE', component: 'PRODUCT_VALUE', side: 'CREDIT', amount: supplierPart, partyType: 'SUPPLIER', partyId: o.supplier_id });
      entries.push({ account: 'RESELLER_MARGIN_REVENUE', component: 'RESELLER_MARGIN', side: 'CREDIT', amount: money(extra - supplierPart), partyType: 'PLATFORM' });
    } else entries.push({ account: 'SUPPLIER_PAYABLE', component: 'PRODUCT_VALUE', side: 'CREDIT', amount: extra, partyType: 'SUPPLIER', partyId: o.supplier_id, memo: 'Tambahan hak mitra: kelebihan berat disetujui' });
    const jid = await postJournal(db, { type: 'WEIGHT_ADJUSTMENT', orderId: o.id, reference: o.order_no, createdBy: u.id, memo: 'Kelebihan berat disetujui pelanggan' }, entries);
    await q(db, `INSERT INTO financial_adjustments(order_id, adjustment_type, components, refund_to_buyer, supplier_deduction, journal_id, created_by) VALUES ($1,'WEIGHT_SURCHARGE','{}'::jsonb,0,0,$2,$3)`, [o.id, jid, u.id]);
    await q(db, `UPDATE orders SET weight_adjustment=$2::jsonb, product_value=product_value+$3, total_amount=total_amount+$3 WHERE id=$1`, [o.id, JSON.stringify({ ...wa, status: 'APPROVED', payment_id: pay.id }), extra]);
    if (packing) await taskTransition(db, packing.id, 'IN_PROGRESS', u.id, 'Pelanggan menyetujui selisih berat; lanjut packing');
    await q(db, `UPDATE escalations SET status='RESOLVED', resolution='Disetujui pelanggan', resolved_at=now() WHERE order_id=$1 AND kind='WEIGHT_VARIANCE' AND status='OPEN'`, [o.id]);
    return { decision, payment: pay };
  }
  await q(db, `UPDATE orders SET weight_adjustment=$2::jsonb WHERE id=$1`, [o.id, JSON.stringify({ ...wa, status: 'DECLINED' })]);
  if (packing) await taskTransition(db, packing.id, 'IN_PROGRESS', u.id, 'Pelanggan menolak selisih; kemas ulang sesuai toleransi', `, instructions='Kemas ulang: berat maksimal ${money(Number(wa.expected) * (1 + Number(wa.tolerance_pct) / 100))} kg (sesuai toleransi).'`);
  await q(db, `UPDATE escalations SET status='RESOLVED', resolution='Ditolak pelanggan; kemas ulang', resolved_at=now() WHERE order_id=$1 AND kind='WEIGHT_VARIANCE' AND status='OPEN'`, [o.id]);
  await notify(db, { orgId: o.supplier_id, kind: 'REPACK', title: `Kemas ulang pesanan ${o.order_no}`, body: 'Pelanggan menolak selisih berat; kemas sesuai toleransi.', link: `/supplier/tasks/${packing?.id ?? ''}` });
  return { decision };
}

/** PACKING: buat paket (ID unik PKG-…), label v1. Reprint menaikkan versi & tercatat; paket lama bisa dibatalkan (bukan dihapus). */
export async function createPackage(db: Db, taskId: string, u: AuthUser, a: { quantity: number; weight_kg?: number; storage_instructions?: string; shelf_life_days?: number; expiry_date?: string }) {
  const t = await assertSupplierTask(db, taskId, u);
  if (t.stage !== 'PACKING') throw conflict('NOT_PACKING_TASK');
  if (!['NEW', 'IN_PROGRESS', 'LATE'].includes(t.status)) throw conflict('TASK_NOT_OPEN', { status: t.status });
  const o = await one(db, `SELECT o.*, c.storage_instructions AS cat_storage, c.shelf_life_days_default FROM orders o JOIN products p ON p.id=o.product_id JOIN categories c ON c.id=p.category_id WHERE o.id=$1`, [t.order_id]);
  if (o.weight_adjustment?.status === 'PENDING_CUSTOMER') throw conflict('WEIGHT_VARIANCE_PENDING');
  const packedSoFar = await one(db, `SELECT COALESCE(SUM(quantity),0) AS n FROM packages WHERE order_id=$1 AND status<>'CANCELLED'`, [o.id]);
  if (Number(packedSoFar.n) + a.quantity > Number(o.quantity) + 1e-9) throw bad('PACKAGE_QUANTITY_EXCEEDS_ORDER', { packed: packedSoFar.n, order: o.quantity });
  if (t.status !== 'IN_PROGRESS') await taskTransition(db, t.id, 'IN_PROGRESS', u.id, 'Packing dimulai', `, started_at=COALESCE(started_at, now()), assignee_id='${u.id}'`);
  const pkgNo = await nextNo(db, 'package', 'PKG');
  const shelf = a.shelf_life_days ?? o.shelf_life_days_default ?? null;
  const expiry = a.expiry_date ?? (shelf ? new Date(Date.now() + shelf * 86400_000).toISOString().slice(0, 10) : null);
  const pkg = await one(db,
    `INSERT INTO packages(package_no, order_id, supplier_id, batch_id, status, quantity, unit, weight_kg, packed_by, storage_instructions, shelf_life_days, expiry_date)
     VALUES ($1,$2,$3,$4,'PACKED',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [pkgNo, o.id, o.supplier_id, o.batch_id, a.quantity, o.unit, a.weight_kg ?? null, u.id, a.storage_instructions ?? o.cat_storage ?? null, shelf, expiry]);
  await q(db, `INSERT INTO package_scans(package_id, code, action, actor_id, actor_role, result, reason) VALUES ($1,$2,'PACK',$3,$4,'OK','Paket dibuat')`, [pkg.id, pkgNo, u.id, u.role]);
  return pkg;
}

export async function recordLabelPrint(db: Db, packageId: string, u: AuthUser, a: { template?: string; reason?: string; reprint?: boolean }) {
  const p = await one(db, 'SELECT * FROM packages WHERE id=$1 FOR UPDATE', [packageId]);
  if (u.role === 'SUPPLIER' && p.supplier_id !== u.orgId) throw forbidden();
  if (p.status === 'CANCELLED') throw conflict('PACKAGE_CANCELLED');
  const prior = await q(db, 'SELECT id FROM label_prints WHERE package_id=$1', [p.id]);
  let version = p.label_version;
  if (prior.length) {
    if (!a.reason) throw bad('REPRINT_REASON_REQUIRED');
    version = p.label_version + 1;
    await q(db, 'UPDATE packages SET label_version=$2 WHERE id=$1', [p.id, version]);
  }
  await q(db, 'INSERT INTO label_prints(package_id, version, template, printed_by, reason) VALUES ($1,$2,$3,$4,$5)', [p.id, version, a.template ?? 'A4', u.id, a.reason ?? null]);
  return { package_id: p.id, version, reprint: prior.length > 0 };
}

export async function cancelPackage(db: Db, packageId: string, u: AuthUser, reason: string) {
  const p = await one(db, 'SELECT * FROM packages WHERE id=$1 FOR UPDATE', [packageId]);
  if (u.role === 'SUPPLIER' && p.supplier_id !== u.orgId) throw forbidden();
  if (!['PACKED', 'HANDED_OVER'].includes(p.status)) throw conflict('PACKAGE_NOT_CANCELLABLE', { status: p.status });
  return one(db, `UPDATE packages SET status='CANCELLED', cancelled_at=now(), cancel_reason=$2 WHERE id=$1 RETURNING *`, [p.id, reason]);
}

/** Selesai PACKING: wajib paket mencakup seluruh kuantitas & label tercetak → order READY_FOR_PICKUP + task HANDOVER. */
export async function completePacking(db: Db, taskId: string, u: AuthUser) {
  const t = await assertSupplierTask(db, taskId, u);
  if (t.stage !== 'PACKING') throw conflict('NOT_PACKING_TASK');
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [t.order_id]);
  const pk = await q(db, `SELECT p.*, (SELECT COUNT(*) FROM label_prints l WHERE l.package_id=p.id)::int AS prints FROM packages p WHERE p.order_id=$1 AND p.status<>'CANCELLED'`, [o.id]);
  const packed = pk.reduce((s, p) => s + Number(p.quantity), 0);
  if (!pk.length || Math.abs(packed - Number(o.quantity)) > 1e-6) throw conflict('PACKAGES_INCOMPLETE', { packed, required: o.quantity });
  if (pk.some((p) => p.prints === 0)) throw conflict('LABEL_NOT_PRINTED', { packages: pk.filter((p) => p.prints === 0).map((p) => p.package_no) });
  const done = await taskTransition(db, t.id, 'DONE', u.id, `Packing selesai: ${pk.length} paket`, `, done_at=now(), result='${JSON.stringify({ packages: pk.map((p) => p.package_no) })}'::jsonb`);
  let order = o;
  if (o.status === 'PROCESSING') order = await transition(db, o.id, 'PACKING', u.id, 'Dikemas', ', packed_at=now()');
  order = await transition(db, order.id, 'READY_FOR_PICKUP', u.id, 'Siap pickup — berlabel', ', ready_at=now()');
  const handover = await createTask(db, order, 'HANDOVER', 'NEW', { deadline: order.promised_pickup_at ? new Date(order.promised_pickup_at) : null, dependsOn: t.id, priority: 1, instructions: 'Serahkan paket ke kurir; kurir memindai setiap paket.' });
  await notify(db, { orgId: order.buyer_id, kind: 'ORDER_READY', title: `Pesanan ${order.order_no} siap dikirim`, link: `/orders/${order.id}` });
  return { task: done, order, next: handover, packages: pk };
}

/** SCAN: validasi kode terhadap record server & aktor; menolak kode asing, paket batal, dan scan duplikat yang mencoba memajukan status. */
const SCAN_NEXT: Record<string, { from: string[]; to: string; roles: string[] }> = {
  HANDOVER: { from: ['PACKED'], to: 'HANDED_OVER', roles: ['SUPPLIER', 'ADMIN'] },
  PICKUP: { from: ['PACKED', 'HANDED_OVER'], to: 'PICKED_UP', roles: ['COURIER', 'ADMIN'] },
  DELIVER: { from: ['PICKED_UP', 'IN_TRANSIT'], to: 'DELIVERED', roles: ['COURIER', 'ADMIN'] },
  RECEIVE: { from: ['DELIVERED'], to: 'RECEIVED', roles: ['BUYER', 'ADMIN'] },
};
export async function scanPackage(db: Db, u: AuthUser, a: { code: string; action: keyof typeof SCAN_NEXT; shipment_id?: string; location?: string; lat?: number; lng?: number }) {
  const rule = SCAN_NEXT[a.action];
  if (!rule) throw bad('INVALID_SCAN_ACTION');
  const code = a.code.trim().toUpperCase();
  const log = async (pkgId: string | null, result: 'OK' | 'REJECTED', reason?: string) => {
    await q(db, `INSERT INTO package_scans(package_id, code, action, actor_id, actor_role, result, reason, location, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [pkgId, code, a.action, u.id, u.role, result, reason ?? null, a.location ?? null, a.lat ?? null, a.lng ?? null]);
    return { code, action: a.action, result, reason: reason ?? null, package: pkgId ? await one(db, 'SELECT * FROM packages WHERE id=$1', [pkgId]) : null };
  };
  const p = await maybe(db, 'SELECT * FROM packages WHERE package_no=$1 FOR UPDATE', [code]);
  if (!p) return log(null, 'REJECTED', 'UNKNOWN_CODE');
  if (!rule.roles.includes(u.role)) return log(p.id, 'REJECTED', 'ROLE_NOT_ALLOWED');
  if (u.role === 'SUPPLIER' && p.supplier_id !== u.orgId) return log(p.id, 'REJECTED', 'NOT_YOUR_PACKAGE');
  if (p.status === 'CANCELLED') return log(p.id, 'REJECTED', 'PACKAGE_CANCELLED');
  if (p.status === rule.to) return log(p.id, 'REJECTED', 'DUPLICATE_SCAN');
  if (!rule.from.includes(p.status)) return log(p.id, 'REJECTED', `ILLEGAL_STATE_${p.status}`);
  if (u.role === 'COURIER') {
    const s = await maybe(db, `SELECT * FROM shipments WHERE id=COALESCE($1, (SELECT shipment_id FROM packages WHERE id=$2)) AND courier_user_id=$3`, [a.shipment_id ?? null, p.id, u.id]);
    if (!s) return log(p.id, 'REJECTED', 'NOT_IN_YOUR_MANIFEST');
    const o = await one(db, 'SELECT id FROM orders WHERE id=$1', [p.order_id]);
    if (s.order_id !== o.id) return log(p.id, 'REJECTED', 'PACKAGE_NOT_IN_SHIPMENT');
    await q(db, 'UPDATE packages SET shipment_id=$2 WHERE id=$1', [p.id, s.id]);
  }
  if (u.role === 'BUYER') {
    const o = await one(db, 'SELECT buyer_id FROM orders WHERE id=$1', [p.order_id]);
    if (o.buyer_id !== u.orgId) return log(p.id, 'REJECTED', 'NOT_YOUR_ORDER');
  }
  await q(db, 'UPDATE packages SET status=$2 WHERE id=$1', [p.id, rule.to]);
  if (a.action === 'HANDOVER') {
    const all = await q(db, `SELECT status FROM packages WHERE order_id=$1 AND status<>'CANCELLED'`, [p.order_id]);
    if (all.every((x) => x.status === 'HANDED_OVER')) {
      const ht = await maybe(db, `SELECT * FROM fulfillment_tasks WHERE order_id=$1 AND stage='HANDOVER' AND status NOT IN ('DONE','CANCELLED')`, [p.order_id]);
      if (ht) await taskTransition(db, ht.id, 'DONE', u.id, 'Semua paket diserahkan ke kurir', ', done_at=now()');
    }
  }
  return log(p.id, 'OK');
}

/** OTP penerima: dibuat saat shipment dibuat; buyer melihatnya di aplikasi; kurir memasukkannya saat serah terima. */
export function generateOtp() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
export const hashOtp = (otp: string, shipmentId: string) => crypto.createHash('sha256').update(`${shipmentId}:${otp}:${process.env.JWT_SECRET ?? 'dev-secret-change-me'}`).digest('hex');

/** Tandai task yang lewat tenggat sebagai LATE + eskalasi (dipakai job). */
export async function markLateTasks(db: Db) {
  const late = await q(db, `UPDATE fulfillment_tasks SET status='LATE', updated_at=now() WHERE deadline < now() AND status IN ('NEW','AWAITING_RESPONSE','IN_PROGRESS') RETURNING *`);
  for (const t of late) {
    await q(db, 'INSERT INTO task_events(task_id, from_status, to_status, note) VALUES ($1,NULL,$2,$3)', [t.id, 'LATE', 'Lewat tenggat (job)']);
    const kind = t.stage === 'ACCEPTANCE' ? 'NO_RESPONSE' : 'SUPPLIER_LATE';
    const exists = await maybe(db, `SELECT id FROM escalations WHERE task_id=$1 AND kind=$2 AND status='OPEN'`, [t.id, kind]);
    if (!exists) await q(db, `INSERT INTO escalations(order_id, task_id, kind, reason) VALUES ($1,$2,$3,$4)`, [t.order_id, t.id, kind, `Task ${t.task_no} (${t.stage}) lewat tenggat ${t.deadline}`]);
    await q(db, `UPDATE orders SET needs_ops_review=TRUE WHERE id=$1`, [t.order_id]);
  }
  return late.length;
}
