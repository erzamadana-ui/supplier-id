import { Db, q, one, maybe } from '../db';
import { getSetting } from './config';

/** AUTOMATED ELIGIBILITY CHECK — memeriksa kelengkapan bukti & aturan, TANPA menyimpulkan siapa yang salah. */
export async function runEligibilityCheck(db: Db, returnCaseId: string) {
  const rc = await one(db, 'SELECT * FROM return_cases WHERE id=$1', [returnCaseId]);
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1', [rc.order_id]);
  const insp = await one(db, 'SELECT * FROM inspections WHERE id=$1', [rc.inspection_id]);
  const ev = await q(db, `SELECT kind FROM evidence_files WHERE return_case_id=$1 OR (order_id=$2 AND owner_type='INSPECTION')`, [rc.id, o.id]);
  const windowH = Number(await getSetting(db, 'return.claim_window_hours', 24));
  const requireVideo = await getSetting(db, 'return.require_video', true);
  const reason = await maybe(db, 'SELECT * FROM return_reason_codes WHERE code=$1', [rc.reason_code]);
  const checks = {
    has_photo: ev.some((e) => e.kind === 'RECEIVING_PHOTO' || e.kind === 'RETURN_PHOTO'),
    has_video: ev.some((e) => e.kind === 'RECEIVING_VIDEO' || e.kind === 'RETURN_VIDEO'),
    within_claim_window: !o.arrived_at || (new Date(insp.received_at).getTime() - new Date(o.arrived_at).getTime()) / 3.6e6 <= windowH,
    quantity_valid: Number(rc.quantity_affected) > 0 && Number(rc.quantity_affected) <= Number(o.quantity),
    reason_active: !!reason?.active,
    supplier_declaration_exists: !!(await maybe(db, 'SELECT 1 FROM declaration_acceptances WHERE batch_id=$1', [rc.batch_id])),
  };
  const videoOk = checks.has_video || !(requireVideo && (reason?.requires_video ?? true));
  const eligible = checks.has_photo && videoOk && checks.within_claim_window && checks.quantity_valid && checks.reason_active;
  const failed = Object.entries({ ...checks, video_ok: videoOk }).filter(([, v]) => !v).map(([k]) => k);
  const eligibility = { eligible, checks: { ...checks, video_ok: videoOk }, failed, checked_at: new Date().toISOString(), note: 'Pemeriksaan otomatis hanya menilai kelengkapan bukti & aturan; atribusi penyebab ditentukan Admin berdasarkan evidence.' };
  return one(db, `UPDATE return_cases SET eligibility=$2::jsonb, status=$3 WHERE id=$1 RETURNING *`,
    [rc.id, JSON.stringify(eligibility), eligible ? 'EVIDENCE_REVIEW' : 'REJECTED']);
}

/** EVIDENCE COMPARISON: BEFORE DELIVERY (deklarasi supplier) ↓ DELIVERY ↓ AT RECEIVING (bukti buyer). */
export async function evidenceComparison(db: Db, returnCaseId: string) {
  const rc = await one(db, `SELECT rc.*, rr.label AS reason_label FROM return_cases rc JOIN return_reason_codes rr ON rr.code=rc.reason_code WHERE rc.id=$1`, [returnCaseId]);
  const o = await one(db, 'SELECT * FROM orders WHERE id=$1', [rc.order_id]);
  const batch = await one(db, `SELECT b.*, p.name AS product_name, p.commodity FROM batches b JOIN products p ON p.id=b.product_id WHERE b.id=$1`, [rc.batch_id]);
  const harvest = await maybe(db, 'SELECT * FROM harvests WHERE batch_id=$1', [rc.batch_id]);
  const declaration = await maybe(db, 'SELECT * FROM declaration_acceptances WHERE batch_id=$1 ORDER BY accepted_at DESC LIMIT 1', [rc.batch_id]);
  const supplierPhotos = await q(db, `SELECT * FROM evidence_files WHERE batch_id=$1 AND owner_type IN ('BATCH','HARVEST_CURRENT','HARVEST_PRE','HARVEST_FINAL') ORDER BY uploaded_at`, [rc.batch_id]);
  const shipment = await one(db, 'SELECT * FROM shipments WHERE id=$1', [rc.shipment_id]);
  const events = await q(db, 'SELECT * FROM shipment_events WHERE shipment_id=$1 ORDER BY occurred_at', [rc.shipment_id]);
  const insp = await one(db, 'SELECT * FROM inspections WHERE id=$1', [rc.inspection_id]);
  const buyerEvidence = await q(db, `SELECT * FROM evidence_files WHERE (return_case_id=$1 OR (order_id=$2 AND owner_type='INSPECTION')) ORDER BY uploaded_at`, [rc.id, o.id]);
  const dispute = await maybe(db, 'SELECT * FROM disputes WHERE return_case_id=$1', [rc.id]);
  const durationH = shipment.pickup_at && shipment.arrived_at ? Math.round(((new Date(shipment.arrived_at).getTime() - new Date(shipment.pickup_at).getTime()) / 3.6e6) * 10) / 10 : null;
  const temps = events.filter((e) => e.temperature_c != null).map((e) => Number(e.temperature_c));
  // SINYAL (bukan kesimpulan): membantu admin, keputusan tetap manusia berbasis bukti
  const signals: string[] = [];
  const declaredTemp = batch.temperature_c ?? batch.attributes?.temperature_c ?? batch.attributes?.storage_temperature_c ?? null;
  if (declaredTemp != null && temps.length && Math.max(...temps) > Number(declaredTemp) + 3) signals.push(`Suhu perjalanan maks ${Math.max(...temps)}°C melebihi deklarasi ${declaredTemp}°C (+3°C)`);
  if (declaredTemp != null && insp.measured_temperature_c != null && Number(insp.measured_temperature_c) > Number(declaredTemp) + 3) signals.push(`Suhu saat diterima ${insp.measured_temperature_c}°C melebihi deklarasi ${declaredTemp}°C (+3°C)`);
  if (events.some((e) => e.event_type === 'DELAY')) signals.push('Ada event DELAY dalam pengiriman');
  if (insp.measured_weight_kg != null && Number(o.weight_kg) > 0) {
    const diff = ((Number(insp.measured_weight_kg) - Number(o.weight_kg)) / Number(o.weight_kg)) * 100;
    if (Math.abs(diff) > Number(batch.weight_tolerance_pct)) signals.push(`Selisih berat ${diff.toFixed(1)}% melebihi toleransi ${batch.weight_tolerance_pct}%`);
  }
  if (!supplierPhotos.length) signals.push('Supplier tidak memiliki foto deklarasi');
  if (!buyerEvidence.some((e) => e.kind.endsWith('VIDEO'))) signals.push('Buyer tidak mengunggah video penerimaan');
  return {
    case: rc, order: o, dispute,
    before_delivery: {
      supplier_photos: supplierPhotos, declaration, harvest,
      declared: { grade: batch.grade, quantity: batch.quantity, expected_weight_kg: batch.expected_weight_kg, harvest_date: batch.harvest_date, condition: batch.condition, size: batch.size, color: batch.color, freshness: batch.freshness, temperature_c: declaredTemp, attributes: batch.attributes, product_name: batch.product_name },
    },
    delivery: { pickup_timestamp: shipment.pickup_at, arrived_timestamp: shipment.arrived_at, duration_hours: durationH, route: shipment.route, events, packaging: shipment.packaging_type, cold_chain: shipment.cold_chain, carrier: shipment.carrier },
    at_receiving: { buyer_photos: buyerEvidence.filter((e) => !e.kind.endsWith('VIDEO')), buyer_videos: buyerEvidence.filter((e) => e.kind.endsWith('VIDEO')), timestamp: insp.received_at, reported_damage: rc.reason_label, reason_code: rc.reason_code, quantity_affected: rc.quantity_affected, description: rc.description, measured_weight_kg: insp.measured_weight_kg, measured_temperature_c: insp.measured_temperature_c, decision: insp.decision },
    signals,
    possible_sources: ['SUPPLIER', 'PACKAGING', 'LOGISTICS', 'BUYER_RECEIVING', 'OTHER', 'UNDETERMINED'],
    guidance: 'Jangan menyimpulkan kesalahan tanpa evidence. Tentukan atribusi berdasarkan perbandingan foto/video, timestamp, dan data pengiriman.',
  };
}
