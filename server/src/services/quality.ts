/**
 * SUPPLIER QUALITY SCORE — skor internal (0–100), bukan sekadar rating bintang.
 * Metrik: successful orders, return rate, damage rate, quality mismatch, weight mismatch, late fulfillment,
 * cancellation, buyer acceptance rate, dispute history, declaration accuracy (akurasi forecast panen).
 * Enforcement bertingkat & configurable (settings quality.enforcement).
 */
import { Db, q, one, maybe } from '../db';
import { getSetting, audit } from './config';

export interface QualityMetrics {
  total_orders: number; successful_orders: number; return_rate: number; damage_rate: number; quality_mismatch_rate: number;
  weight_mismatch_rate: number; late_fulfillment_rate: number; cancellation_rate: number; buyer_acceptance_rate: number;
  dispute_rate: number; declaration_accuracy: number; returned_qty_rate: number;
}

export async function computeSupplierMetrics(db: Db, supplierId: string): Promise<QualityMetrics> {
  const o = await one<any>(
    db,
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('DRAFT','PENDING_PAYMENT'))::int AS total,
       COUNT(*) FILTER (WHERE status IN ('ACCEPTED','SETTLED') AND COALESCE(rejected_quantity,0)=0)::int AS successful,
       COUNT(*) FILTER (WHERE status='CANCELLED')::int AS cancelled,
       COUNT(*) FILTER (WHERE inspected_at IS NOT NULL)::int AS inspected,
       COUNT(*) FILTER (WHERE inspected_at IS NOT NULL AND COALESCE(rejected_quantity,0)>0)::int AS with_rejection,
       COUNT(*) FILTER (WHERE picked_up_at IS NOT NULL AND promised_pickup_at IS NOT NULL AND picked_up_at > promised_pickup_at)::int AS late,
       COALESCE(SUM(accepted_quantity),0) AS acc_qty,
       COALESCE(SUM(quantity) FILTER (WHERE inspected_at IS NOT NULL),0) AS insp_qty
     FROM orders WHERE supplier_id=$1`,
    [supplierId],
  );
  const r = await one<any>(
    db,
    `SELECT
       COUNT(*) FILTER (WHERE fault_attribution IS NULL OR fault_attribution NOT IN ('LOGISTICS','BUYER_RECEIVING'))::int AS returns,
       COUNT(*) FILTER (WHERE reason_code IN ('DAMAGED','ROTTEN','PACKAGING_DAMAGE','TEMPERATURE_ISSUE'))::int AS damage,
       COUNT(*) FILTER (WHERE reason_code IN ('WRONG_GRADE','WRONG_SIZE','NOT_FRESH','QUALITY_NOT_AS_DECLARED','WRONG_PRODUCT'))::int AS mismatch,
       COUNT(*) FILTER (WHERE reason_code IN ('WEIGHT_MISMATCH','QUANTITY_MISMATCH'))::int AS weight,
       COUNT(*) FILTER (WHERE fault_attribution IN ('SUPPLIER','PACKAGING'))::int AS supplier_fault,
       COALESCE(SUM(approved_quantity),0) AS approved_qty
     FROM return_cases WHERE supplier_id=$1`,
    [supplierId],
  );
  const d = await one<any>(db, `SELECT COUNT(*)::int AS disputes FROM disputes d JOIN orders o ON o.id=d.order_id WHERE o.supplier_id=$1`, [supplierId]);
  const h = await one<any>(
    db,
    `SELECT COUNT(*)::int AS n, COALESCE(AVG(1 - LEAST(1, ABS(actual_quantity-expected_quantity)/NULLIF(expected_quantity,0))),1) AS acc
     FROM harvests hv JOIN batches b ON b.id=hv.batch_id WHERE b.supplier_id=$1 AND hv.stage='FINAL'`,
    [supplierId],
  );
  const total = Number(o.total) || 0;
  const pct = (n: number, dnm: number) => (dnm > 0 ? Math.round((n / dnm) * 10000) / 100 : 0);
  return {
    total_orders: total,
    successful_orders: Number(o.successful),
    return_rate: pct(Number(r.returns), total),
    damage_rate: pct(Number(r.damage), total),
    quality_mismatch_rate: pct(Number(r.mismatch), total),
    weight_mismatch_rate: pct(Number(r.weight), total),
    late_fulfillment_rate: pct(Number(o.late), total),
    cancellation_rate: pct(Number(o.cancelled), total),
    buyer_acceptance_rate: Number(o.insp_qty) > 0 ? pct(Number(o.acc_qty), Number(o.insp_qty)) : 100,
    dispute_rate: pct(Number(d.disputes), total),
    declaration_accuracy: Math.round(Number(h.acc) * 10000) / 100,
    returned_qty_rate: Number(o.insp_qty) > 0 ? pct(Number(r.approved_qty), Number(o.insp_qty)) : 0,
  };
}

export function scoreFromMetrics(m: QualityMetrics, w: Record<string, number>) {
  // setiap sub-skor 0..1 (1 = terbaik), dikali bobot; penalti linier, jenuh pada 50% untuk rate buruk
  const good = (rate: number, sat = 50) => Math.max(0, 1 - rate / sat);
  const parts: Record<string, number> = {
    acceptance_rate: (m.buyer_acceptance_rate / 100) * (w.acceptance_rate ?? 0),
    return_rate: good(m.return_rate) * (w.return_rate ?? 0),
    damage_rate: good(m.damage_rate) * (w.damage_rate ?? 0),
    quality_mismatch: good(m.quality_mismatch_rate) * (w.quality_mismatch ?? 0),
    weight_mismatch: good(m.weight_mismatch_rate) * (w.weight_mismatch ?? 0),
    late_fulfillment: good(m.late_fulfillment_rate) * (w.late_fulfillment ?? 0),
    cancellation: good(m.cancellation_rate) * (w.cancellation ?? 0),
    dispute_history: good(m.dispute_rate) * (w.dispute_history ?? 0),
    declaration_accuracy: (m.declaration_accuracy / 100) * (w.declaration_accuracy ?? 0),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score: Math.round(total * 100) / 100, parts };
}

export function decideEnforcement(m: QualityMetrics, cfg: any) {
  const actions: string[] = [];
  if (m.total_orders < (cfg.min_orders ?? 3)) return { level: 'NONE', status: 'ACTIVE', actions, note: 'Belum cukup order untuk enforcement' };
  const rr = m.return_rate;
  let status = 'ACTIVE';
  if (rr > (cfg.under_review?.return_rate_gt ?? 40)) { status = 'UNDER_REVIEW'; actions.push('ACCOUNT_REVIEW'); }
  else if (rr > (cfg.listing_limited?.return_rate_gt ?? 30)) { status = 'LISTING_LIMITED'; actions.push('LISTING_LIMITED'); }
  else if (rr > (cfg.verification_required?.return_rate_gt ?? 20)) { status = 'VERIFICATION_REQUIRED'; actions.push('ADDITIONAL_VERIFICATION'); }
  else if (rr > (cfg.rank_down?.return_rate_gt ?? 15)) { status = 'WARNING'; actions.push('RANK_DOWN', 'WARNING'); }
  else if (rr > (cfg.warning?.return_rate_gt ?? 10)) { status = 'WARNING'; actions.push('WARNING'); }
  return { level: status, status, actions, note: `return_rate=${rr}%` };
}

export async function recomputeQualityScore(db: Db, supplierId: string, actorId: string | null = null) {
  const [weights, enfCfg] = await Promise.all([getSetting(db, 'quality.weights'), getSetting(db, 'quality.enforcement')]);
  const metrics = await computeSupplierMetrics(db, supplierId);
  const { score, parts } = scoreFromMetrics(metrics, weights);
  const enforcement = decideEnforcement(metrics, enfCfg);
  await q(
    db,
    `INSERT INTO supplier_quality_scores(supplier_id, score, metrics, enforcement) VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
    [supplierId, score, JSON.stringify({ ...metrics, parts }), JSON.stringify(enforcement)],
  );
  const org = await one(db, 'SELECT status FROM organizations WHERE id=$1', [supplierId]);
  // status manual SUSPENDED tidak di-override otomatis
  if (org.status !== 'SUSPENDED' && org.status !== enforcement.status) {
    await q(db, 'UPDATE organizations SET status=$2, status_reason=$3 WHERE id=$1', [supplierId, enforcement.status, enforcement.note]);
    await audit(db, 'organizations', supplierId, 'ENFORCEMENT', { status: org.status }, { status: enforcement.status, actions: enforcement.actions }, actorId, enforcement.note);
  }
  return { score, metrics, parts, enforcement };
}

export async function latestQualityScore(db: Db, supplierId: string) {
  return maybe(db, 'SELECT * FROM supplier_quality_scores WHERE supplier_id=$1 ORDER BY computed_at DESC LIMIT 1', [supplierId]);
}
