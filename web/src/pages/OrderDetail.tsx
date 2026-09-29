import { ReactElement, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, d, dt, errMsg, FAULT_LABEL, num, ORDER_STATUS_LABEL, pct, RETURN_STATUS_LABEL, rupiah } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, AsyncButton, Badge, Card, Empty, EvidenceGallery, Field, statusTone, Timeline, useAsync } from '../components/ui';
import { compact, KV, shipmentEventItems, SummaryTable, TaxLines } from './buyer/shared';

const STEPS = ['Konfirmasi', 'Bayar', 'Packing', 'Pickup', 'Perjalanan', 'Tiba', 'Inspeksi', 'Settle'];
const STEP_INDEX: Record<string, number> = {
  DRAFT: 0, PENDING_PAYMENT: 1, PAID: 2, PACKING: 3, PICKED_UP: 4, IN_TRANSIT: 5, ARRIVED_WAITING_INSPECTION: 6,
  ACCEPTED: 7, PARTIALLY_ACCEPTED: 7, REJECTED: 7, DISPUTED: 7, SETTLED: 8, CANCELLED: -1,
};
const PAYMENT_STATUS_LABEL: Record<string, string> = { PENDING: 'Menunggu', PAID: 'Dibayar', FAILED: 'Gagal', REFUNDED: 'Direfund', PARTIALLY_REFUNDED: 'Refund sebagian' };
const SHIPMENT_STATUS_LABEL: Record<string, string> = { SCHEDULED: 'Dijadwalkan', PICKED_UP: 'Diambil', IN_TRANSIT: 'Dalam perjalanan', ARRIVED: 'Tiba', DELIVERED: 'Terkirim', RECEIVED: 'Diterima' };
const DECISION_LABEL: Record<string, string> = { ACCEPT: 'Diterima penuh', PARTIAL_ACCEPT: 'Diterima sebagian', REJECT: 'Ditolak' };
const ADJ_TYPE_LABEL: Record<string, string> = { RETURN_REFUND: 'Refund retur', CANCELLATION: 'Pembatalan', MANUAL: 'Manual' };

export default function OrderDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const role = user?.role ?? 'BUYER';
  const { data: o, error, loading, reload } = useAsync<any>(() => api.get(`/api/orders/${id}`), [id]);
  const recon = useAsync<any>(() => (role === 'ADMIN' ? api.get(`/api/orders/${id}/reconcile`) : Promise.resolve(null)), [id, role, o?.status]);

  if (loading) return <p className="muted">Memuat order…</p>;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!o) return null;

  const snap = o.pricing_snapshot ?? {};
  const feeCfg = snap.fee_config ?? snap.feeConfig ?? null;
  const stepIdx = STEP_INDEX[o.status] ?? 0;
  const deliveryShipments = (o.shipments ?? []).filter((s: any) => s.type === 'DELIVERY');
  const lastDelivery = deliveryShipments[deliveryShipments.length - 1];
  const supplierEvidence = (o.evidence ?? []).filter((e: any) => ['BATCH', 'HARVEST_CURRENT', 'HARVEST_PRE', 'HARVEST_FINAL'].includes(e.owner_type));
  const buyerEvidence = (o.evidence ?? []).filter((e: any) => ['INSPECTION', 'RETURN'].includes(e.owner_type));
  const otherEvidence = (o.evidence ?? []).filter((e: any) => !['BATCH', 'HARVEST_CURRENT', 'HARVEST_PRE', 'HARVEST_FINAL', 'INSPECTION', 'RETURN'].includes(e.owner_type));

  return (
    <>
      <div className="page-head">
        <div>
          <small className="muted">
            {role === 'BUYER' && <Link to="/buyer/orders">Pesanan</Link>}
            {role === 'SUPPLIER' && <Link to="/supplier/orders">Pesanan</Link>}
            {role === 'ADMIN' && <Link to="/admin/orders">Semua order</Link>}
            {' / '}{o.order_no}
          </small>
          <h1>{o.order_no} <Badge tone={statusTone(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge></h1>
          <p>
            <b>{o.product_name}</b> · batch {o.batch_code}{o.batch_grade ? ` · Grade ${o.batch_grade}` : ''} · {num(o.quantity, 3)} {o.unit} × {rupiah(o.unit_price)}
            <br />Supplier: <b>{o.supplier_name}</b> · Buyer: <b>{o.buyer_name}</b>
            {o.rfq_id && <> · <small className="muted">dari RFQ / negosiasi</small></>}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="stat-label">Total pembayaran</div>
          <div className="stat-value" style={{ fontSize: 24 }}>{rupiah(o.total_amount)}</div>
          <small className="muted">dibuat {dt(o.created_at)}</small>
        </div>
      </div>

      {o.status === 'CANCELLED'
        ? <Alert kind="error">Order dibatalkan pada {dt(o.cancelled_at)}.</Alert>
        : (
          <div className="steps">
            {STEPS.map((s, i) => <span key={s} className={i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''}>{i + 1}. {s}</span>)}
          </div>
        )}

      <Actions o={o} role={role} reload={reload} lastDelivery={lastDelivery} buyerEvidence={buyerEvidence} />

      <div className="grid cols-2">
        <div>
          <Card title="Ringkasan harga (pricing snapshot terkunci)">
            <SummaryTable m={{
              productValue: Number(o.product_value), quantity: Number(o.quantity), unit: o.unit, unitPrice: Number(o.unit_price),
              platformFeeRate: o.platform_fee_rate, platformFeeAmount: Number(o.platform_fee_amount), packagingAmount: Number(o.packaging_amount),
              logisticsAmount: Number(o.logistics_amount), paymentFeeAmount: Number(o.payment_fee_amount), optionalAmount: Number(o.optional_amount),
              optionalLines: o.optional_services ?? [], discountAmount: Number(o.discount_amount), discountLine: snap.discountLine ?? (o.promo_code ? { code: o.promo_code, label: 'Promo' } : null),
              taxAmount: Number(o.tax_amount), taxLines: snap.taxLines ?? [], totalAmount: Number(o.total_amount),
            }} />
            <div style={{ marginTop: 10 }}>
              <KV rows={[
                ['Harga dikunci', o.pricing_locked_at ? dt(o.pricing_locked_at) : <Badge tone="warn">Belum dikunci (DRAFT — preview)</Badge>],
                ['Fee config', feeCfg ? `${feeCfg.scope_type}${feeCfg.scope_ref ? ` (${feeCfg.scope_ref})` : ''} · ${pct(feeCfg.rate_percent)} · berlaku sejak ${d(feeCfg.effective_from)}` : '-'],
                ['Berat (kg)', num(o.weight_kg, 3)], ['Jarak (km)', num(o.distance_km, 2)], ['Alamat kirim', o.delivery_address ?? '-'],
              ]} />
              <small className="muted">Perubahan platform fee di kemudian hari tidak mengubah order ini.</small>
            </div>
          </Card>

          <Card title="Pembayaran">
            {!(o.payments ?? []).length ? <Empty>Belum ada pembayaran.</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Provider</th><th>Channel</th><th className="num">Jumlah</th><th>Status</th><th>Dibayar</th><th>Ref</th></tr></thead>
                <tbody>{o.payments.map((p: any) => (
                  <tr key={p.id}><td>{p.provider}</td><td>{p.channel}</td><td className="num">{rupiah(p.amount)}</td><td><Badge tone={statusTone(p.status)}>{PAYMENT_STATUS_LABEL[p.status] ?? p.status}</Badge></td><td>{dt(p.paid_at)}</td><td><code>{p.provider_ref}</code></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>

          <Card title="Pengiriman & live tracking">
            {!(o.shipments ?? []).length ? <Empty>Belum ada pengiriman.</Empty> : o.shipments.map((s: any) => (
              <div key={s.id} style={{ marginBottom: 14 }}>
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{s.type === 'RETURN' ? 'Pengiriman retur' : 'Pengiriman'} <Badge>{SHIPMENT_STATUS_LABEL[s.status] ?? s.status}</Badge></h3>
                  <code>{s.tracking_no}</code>
                </div>
                <KV rows={[
                  ['Kurir', s.carrier], ['Driver', s.driver_name], ['Kendaraan', s.vehicle], ['Kemasan', s.packaging_type],
                  ['Cold chain', s.cold_chain ? 'Ya' : 'Tidak'], ['Pickup', dt(s.pickup_at)], ['Tiba', dt(s.arrived_at)],
                ]} />
                <div style={{ marginTop: 8 }}>
                  {(s.events ?? []).length ? <Timeline items={shipmentEventItems(s.events)} /> : <Empty>Belum ada event tracking.</Empty>}
                </div>
              </div>
            ))}
          </Card>

          <Card title="Inspeksi penerimaan">
            {!o.inspection ? <Empty>Belum ada inspeksi.</Empty> : (
              <KV rows={[
                ['Keputusan', <Badge tone={o.inspection.decision === 'ACCEPT' ? 'good' : o.inspection.decision === 'REJECT' ? 'bad' : 'warn'}>{DECISION_LABEL[o.inspection.decision] ?? o.inspection.decision}</Badge>],
                ['Diterima pada', dt(o.inspection.received_at)],
                ['Kuantitas diterima', `${num(o.inspection.accepted_quantity, 3)} ${o.unit}`], ['Kuantitas ditolak', `${num(o.inspection.rejected_quantity, 3)} ${o.unit}`],
                ['Berat terukur (kg)', o.inspection.measured_weight_kg != null ? num(o.inspection.measured_weight_kg, 3) : '-'],
                ['Suhu terukur (°C)', o.inspection.measured_temperature_c != null ? num(o.inspection.measured_temperature_c, 1) : '-'],
                ['Catatan', o.inspection.notes],
              ]} />
            )}
          </Card>

          <Card title="Retur / klaim">
            {!(o.return_cases ?? []).length ? <Empty>Tidak ada klaim retur.</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr><th>No. kasus</th><th>Status</th><th>Alasan</th><th className="num">Kuantitas</th><th>Atribusi</th><th>Dibuat</th></tr></thead>
                <tbody>{o.return_cases.map((rc: any) => (
                  <tr key={rc.id}>
                    <td><Link to={`/returns/${rc.id}`}><b>{rc.case_no}</b></Link></td>
                    <td><Badge tone={statusTone(rc.status)}>{RETURN_STATUS_LABEL[rc.status] ?? rc.status}</Badge></td>
                    <td>{rc.reason_code}</td>
                    <td className="num">{num(rc.quantity_affected, 3)} {o.unit}</td>
                    <td>{rc.fault_attribution ? FAULT_LABEL[rc.fault_attribution] ?? rc.fault_attribution : <span className="muted">belum diputus</span>}</td>
                    <td>{dt(rc.created_at)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>

          <Card title="Financial adjustments">
            {!(o.adjustments ?? []).length ? <Empty>Tidak ada penyesuaian finansial.</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Tipe</th><th>Atribusi</th><th className="num">Refund ke buyer</th><th className="num">Potongan supplier</th><th className="num">Ditanggung platform</th><th className="num">Recovery logistik</th><th className="num">Pembalikan pajak</th><th>Waktu</th></tr></thead>
                <tbody>{o.adjustments.map((a: any) => (
                  <tr key={a.id}>
                    <td>{ADJ_TYPE_LABEL[a.adjustment_type] ?? a.adjustment_type}</td>
                    <td>{a.fault_attribution ? FAULT_LABEL[a.fault_attribution] ?? a.fault_attribution : '-'}</td>
                    <td className="num">{rupiah(a.refund_to_buyer)}</td><td className="num">{rupiah(a.supplier_deduction)}</td>
                    <td className="num">{rupiah(a.platform_absorbed)}</td><td className="num">{rupiah(a.logistics_recovery)}</td><td className="num">{rupiah(a.tax_reversal)}</td>
                    <td>{dt(a.created_at)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>

        <div>
          <Card title="Bukti (evidence trail)">
            <h4 className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>DEKLARASI SUPPLIER — sebelum pengiriman ({supplierEvidence.length})</h4>
            <EvidenceGallery files={supplierEvidence} emptyText="Tidak ada foto deklarasi supplier." />
            <h4 className="muted" style={{ margin: '14px 0 6px', fontSize: 12 }}>PENERIMAAN BUYER — saat barang tiba ({buyerEvidence.length})</h4>
            <EvidenceGallery files={buyerEvidence} emptyText="Belum ada bukti penerimaan buyer." />
            {otherEvidence.length > 0 && <>
              <h4 className="muted" style={{ margin: '14px 0 6px', fontSize: 12 }}>LAINNYA ({otherEvidence.length})</h4>
              <EvidenceGallery files={otherEvidence} />
            </>}
          </Card>

          <Card title="Riwayat status">
            {!(o.events ?? []).length ? <Empty /> : (
              <Timeline items={o.events.map((e: any) => ({ at: e.created_at, title: `${e.from_status ? (ORDER_STATUS_LABEL[e.from_status] ?? e.from_status) + ' → ' : ''}${ORDER_STATUS_LABEL[e.to_status] ?? e.to_status}`, note: e.note }))} />
            )}
          </Card>

          {role === 'ADMIN' && (
            <Card title="Rekonsiliasi (admin)">
              {recon.error && <Alert kind="error">{recon.error}</Alert>}
              {recon.data && (
                <>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <Badge tone={recon.data.balanced ? 'good' : 'bad'}>{recon.data.balanced ? 'Balanced' : 'Tidak balance'}</Badge>
                    <small className="muted">{recon.data.formula}</small>
                  </div>
                  <div className="stats">
                    <div className="stat"><div className="stat-label">Money in</div><div className="stat-value">{rupiah(recon.data.moneyIn)}</div></div>
                    <div className="stat"><div className="stat-label">Money out</div><div className="stat-value">{rupiah(recon.data.moneyOut)}</div></div>
                    <div className="stat"><div className="stat-label">Liabilities</div><div className="stat-value">{rupiah(recon.data.liabilities)}</div></div>
                    <div className="stat"><div className="stat-label">Tax</div><div className="stat-value">{rupiah(recon.data.tax)}</div></div>
                    <div className="stat"><div className="stat-label">Net revenue</div><div className="stat-value">{rupiah(recon.data.netRevenue)}</div></div>
                    <div className={`stat ${Math.abs(Number(recon.data.variance)) < 0.005 ? 'good' : 'bad'}`}><div className="stat-label">Variance</div><div className="stat-value">{rupiah(recon.data.variance)}</div></div>
                  </div>
                  {(recon.data.unbalancedJournals ?? []).length > 0 && <Alert kind="error">Jurnal tidak seimbang: {recon.data.unbalancedJournals.map((j: any) => j.journal_type).join(', ')}</Alert>}
                </>
              )}
            </Card>
          )}

          {role === 'ADMIN' && (
            <Card title="Ledger (admin only)">
              {!(o.ledger ?? []).length ? <Empty>Belum ada entri ledger.</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Waktu</th><th>Jurnal</th><th>Akun</th><th>Komponen</th><th>Sisi</th><th className="num">Jumlah</th><th>Memo</th></tr></thead>
                  <tbody>{o.ledger.map((l: any) => (
                    <tr key={l.id}><td><small>{dt(l.posted_at)}</small></td><td>{l.journal_type}</td><td>{l.account}</td><td>{l.component}</td><td>{l.side}</td><td className="num">{rupiah(l.amount)}</td><td><small>{l.memo}</small></td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}

          {snap.taxLines && (
            <Card title="Rincian pajak per komponen">
              <TaxLines lines={snap.taxLines} />
              <small className="muted">Pajak dihitung per komponen sesuai aturan tax engine yang berlaku saat harga dikunci.</small>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// TINDAKAN PER PERAN
// ----------------------------------------------------------------------------
function Actions({ o, role, reload, lastDelivery, buyerEvidence }: { o: any; role: string; reload: () => Promise<void>; lastDelivery: any; buyerEvidence: any[] }) {
  const nav = useNavigate();
  const [channel, setChannel] = useState('VA');
  const [cancelReason, setCancelReason] = useState('');
  const [packType, setPackType] = useState('Karung/Box standar');
  const [pickup, setPickup] = useState({ carrier: 'Supplier.id Logistics Partner', driver_name: '', vehicle: '', cold_chain: false });
  const [ev, setEv] = useState({ event_type: 'CHECKPOINT', location: '', temperature_c: '', note: '' });

  const s = o.status;
  const items: ReactElement[] = [];

  // ---------- BUYER ----------
  if (role === 'BUYER') {
    if (s === 'DRAFT') items.push(
      <div key="confirm">
        <p>Harga akan dihitung ulang dengan konfigurasi saat ini lalu <b>dikunci</b> (pricing snapshot). Stok batch dialokasikan untuk order ini.</p>
        <AsyncButton onClick={async () => { await api.post(`/api/orders/${o.id}/confirm`); await reload(); }}>Konfirmasi pesanan (kunci harga)</AsyncButton>
      </div>,
    );
    if (s === 'PENDING_PAYMENT') items.push(
      <div key="pay">
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <Field label="Channel pembayaran">
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="VA">Virtual Account</option><option value="QRIS">QRIS</option><option value="CARD">Kartu kredit/debit</option>
            </select>
          </Field>
          <div className="form-actions">
            <AsyncButton onClick={async () => { await api.post(`/api/orders/${o.id}/pay`, { channel }); await reload(); }}>Bayar sekarang — {rupiah(o.total_amount)}</AsyncButton>
          </div>
        </form>
        <small className="muted">Gateway pembayaran mock; dana masuk ke escrow platform.</small>
      </div>,
    );
    if (['DRAFT', 'PENDING_PAYMENT'].includes(s)) items.push(<CancelForm key="cancel" o={o} reason={cancelReason} setReason={setCancelReason} reload={reload} />);
    if (s === 'ARRIVED_WAITING_INSPECTION') items.push(<InspectionForm key="insp" o={o} buyerEvidence={buyerEvidence} reload={reload} onReturn={(rid) => nav(`/returns/${rid}`)} />);
  }

  // ---------- SUPPLIER / ADMIN ----------
  if (role === 'SUPPLIER' || role === 'ADMIN') {
    if (s === 'PAID' && role === 'SUPPLIER') items.push(
      <form key="pack" className="inline" onSubmit={(e) => e.preventDefault()}>
        <Field label="Jenis kemasan"><input value={packType} onChange={(e) => setPackType(e.target.value)} /></Field>
        <div className="form-actions"><AsyncButton onClick={async () => { await api.post(`/api/orders/${o.id}/pack`, { packaging_type: packType }); await reload(); }}>Packing selesai</AsyncButton></div>
      </form>,
    );
    if (s === 'PACKING' && role === 'SUPPLIER') items.push(
      <form key="pickup" className="inline" onSubmit={(e) => e.preventDefault()}>
        <Field label="Kurir" required><input value={pickup.carrier} onChange={(e) => setPickup({ ...pickup, carrier: e.target.value })} /></Field>
        <Field label="Nama driver"><input value={pickup.driver_name} onChange={(e) => setPickup({ ...pickup, driver_name: e.target.value })} /></Field>
        <Field label="Kendaraan / plat"><input value={pickup.vehicle} onChange={(e) => setPickup({ ...pickup, vehicle: e.target.value })} /></Field>
        <Field label="Cold chain"><label className="row"><input type="checkbox" checked={pickup.cold_chain} onChange={(e) => setPickup({ ...pickup, cold_chain: e.target.checked })} /> Menggunakan cold chain</label></Field>
        <div className="form-actions"><AsyncButton onClick={async () => { await api.post(`/api/orders/${o.id}/pickup`, compact({ ...pickup, cold_chain: pickup.cold_chain })); await reload(); }}>Serahkan ke kurir (pickup)</AsyncButton></div>
      </form>,
    );
    if (['PICKED_UP', 'IN_TRANSIT'].includes(s) && lastDelivery) items.push(
      <div key="track">
        <h4 style={{ margin: '0 0 6px' }}>Tambah event tracking — {lastDelivery.tracking_no}</h4>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <Field label="Jenis event">
            <select value={ev.event_type} onChange={(e) => setEv({ ...ev, event_type: e.target.value })}>
              <option value="CHECKPOINT">Checkpoint</option><option value="TEMPERATURE">Pembacaan suhu</option><option value="DELAY">Keterlambatan</option>
            </select>
          </Field>
          <Field label="Lokasi"><input value={ev.location} onChange={(e) => setEv({ ...ev, location: e.target.value })} placeholder="mis. Tol Pekanbaru KM 12" /></Field>
          <Field label="Suhu (°C)"><input type="number" step="any" value={ev.temperature_c} onChange={(e) => setEv({ ...ev, temperature_c: e.target.value })} /></Field>
          <Field label="Catatan"><input value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} /></Field>
          <div className="form-actions">
            <AsyncButton className="btn secondary" onClick={async () => {
              await api.post(`/api/shipments/${lastDelivery.id}/events`, compact({ event_type: ev.event_type, location: ev.location, temperature_c: ev.temperature_c === '' ? '' : Number(ev.temperature_c), note: ev.note }));
              setEv({ ...ev, location: '', temperature_c: '', note: '' });
              await reload();
            }}>Catat event</AsyncButton>
            <AsyncButton confirm="Tandai pengiriman tiba di lokasi buyer? Order akan menunggu inspeksi buyer." onClick={async () => { await api.post(`/api/shipments/${lastDelivery.id}/arrive`); await reload(); }}>Tiba di buyer</AsyncButton>
          </div>
        </form>
      </div>,
    );
    if (['PAID', 'PACKING'].includes(s)) items.push(<CancelForm key="cancel" o={o} reason={cancelReason} setReason={setCancelReason} reload={reload} note="Pembatalan setelah bayar memicu refund ke buyer (payment fee mengikuti aturan provider) dan stok dikembalikan." />);
  }

  if (!items.length) return null;
  return <Card title="Tindakan">{items.map((it, i) => <div key={i} style={i ? { borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 } : undefined}>{it}</div>)}</Card>;
}

function CancelForm({ o, reason, setReason, reload, note }: { o: any; reason: string; setReason: (v: string) => void; reload: () => Promise<void>; note?: string }) {
  return (
    <form className="inline" onSubmit={(e) => e.preventDefault()}>
      <Field label="Alasan pembatalan" required><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wajib diisi" /></Field>
      <div className="form-actions">
        <AsyncButton className="btn danger" disabled={!reason.trim()} confirm="Batalkan order ini?" onClick={async () => { await api.post(`/api/orders/${o.id}/cancel`, { reason }); await reload(); }}>Batalkan order</AsyncButton>
        {note && <small className="muted">{note}</small>}
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------
// FORM INSPEKSI BUYER
// ----------------------------------------------------------------------------
function InspectionForm({ o, buyerEvidence, reload, onReturn }: { o: any; buyerEvidence: any[]; reload: () => Promise<void>; onReturn: (returnId: string) => void }) {
  const reasons = useAsync<any[]>(() => api.get('/api/reason-codes'), []);
  const [decision, setDecision] = useState<'ACCEPT' | 'PARTIAL_ACCEPT' | 'REJECT'>('ACCEPT');
  const [acceptedQty, setAcceptedQty] = useState('');
  const [f, setF] = useState({ reason_code: '', description: '', measured_weight_kg: '', measured_temperature_c: '', notes: '' });
  const [uploadErr, setUploadErr] = useState('');
  const [uploading, setUploading] = useState(0);
  const [result, setResult] = useState<any>(null);

  const qty = Number(o.quantity);
  const acc = Number(acceptedQty);
  const rejected = decision === 'ACCEPT' ? 0 : decision === 'REJECT' ? qty : acc > 0 && acc < qty ? qty - acc : NaN;
  const isClaim = decision !== 'ACCEPT';
  const inspEv = buyerEvidence.filter((e) => e.owner_type === 'INSPECTION');
  const photos = inspEv.filter((e) => e.kind === 'RECEIVING_PHOTO').length;
  const videos = inspEv.filter((e) => e.kind === 'RECEIVING_VIDEO').length;
  const selReason = (reasons.data ?? []).find((r) => r.code === f.reason_code);
  const needVideo = selReason ? selReason.requires_video !== false : true;
  const evidenceOk = !isClaim || (photos > 0 && (!needVideo || videos > 0));
  const partialInvalid = decision === 'PARTIAL_ACCEPT' && !(acc > 0 && acc < qty);
  const canSubmit = !partialInvalid && (!isClaim || !!f.reason_code) && evidenceOk && uploading === 0;

  const upload = async (files: FileList | null, kind: 'RECEIVING_PHOTO' | 'RECEIVING_VIDEO') => {
    if (!files?.length) return;
    setUploadErr(''); setUploading((n) => n + files.length);
    try {
      for (const file of Array.from(files)) {
        try { await api.upload(file, { owner_type: 'INSPECTION', kind, order_id: o.id, taken_at: new Date().toISOString() }); }
        catch (e) { setUploadErr((p) => (p ? p + '; ' : '') + `${file.name}: ${errMsg(e)}`); }
        finally { setUploading((n) => n - 1); }
      }
    } finally { await reload(); }
  };

  return (
    <div>
      <h3>Inspeksi penerimaan</h3>
      <Alert kind="warn"><b>Klaim wajib foto + video</b> kondisi barang saat diterima, <b>sebelum</b> barang digunakan/diproses. Tanpa bukti lengkap, klaim tidak dapat diajukan.</Alert>
      <div className="row" style={{ marginBottom: 10 }}>
        {(['ACCEPT', 'PARTIAL_ACCEPT', 'REJECT'] as const).map((k) => (
          <label key={k} className="row"><input type="radio" name="decision" checked={decision === k} onChange={() => setDecision(k)} /> {DECISION_LABEL[k]}</label>
        ))}
      </div>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        {decision === 'PARTIAL_ACCEPT' && (
          <Field label={`Kuantitas diterima (${o.unit})`} required hint={`Harus lebih dari 0 dan kurang dari ${num(qty, 3)}. Ditolak: ${Number.isNaN(rejected) ? '-' : num(rejected, 3)} ${o.unit}`}>
            <input type="number" min={0} max={qty} step="any" value={acceptedQty} onChange={(e) => setAcceptedQty(e.target.value)} />
          </Field>
        )}
        {isClaim && (
          <>
            <Field label="Alasan klaim" required>
              <select value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })}>
                <option value="">— pilih —</option>
                {(reasons.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.label}{r.requires_video ? ' (wajib video)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Deskripsi kondisi"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Jelaskan ketidaksesuaian" /></Field>
            <Field label="Berat terukur (kg)"><input type="number" step="any" value={f.measured_weight_kg} onChange={(e) => setF({ ...f, measured_weight_kg: e.target.value })} /></Field>
            <Field label="Suhu terukur (°C)"><input type="number" step="any" value={f.measured_temperature_c} onChange={(e) => setF({ ...f, measured_temperature_c: e.target.value })} /></Field>
          </>
        )}
        <Field label="Catatan inspeksi"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </form>

      {isClaim && (
        <div style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: 12, margin: '10px 0' }}>
          <h4 style={{ margin: '0 0 8px' }}>Bukti penerimaan (wajib untuk klaim)</h4>
          <div className="grid cols-2">
            <Field label="Foto kondisi barang saat diterima" required hint={`Terunggah: ${photos} foto`}>
              <input type="file" accept="image/*" multiple onChange={(e) => { upload(e.target.files, 'RECEIVING_PHOTO'); e.currentTarget.value = ''; }} />
            </Field>
            <Field label="Video kondisi barang" required={needVideo} hint={`Terunggah: ${videos} video${needVideo ? '' : ' (opsional untuk alasan ini)'}`}>
              <input type="file" accept="video/*" onChange={(e) => { upload(e.target.files, 'RECEIVING_VIDEO'); e.currentTarget.value = ''; }} />
            </Field>
          </div>
          {uploading > 0 && <small className="muted">Mengunggah {uploading} berkas…</small>}
          {uploadErr && <Alert kind="error">{uploadErr}</Alert>}
          <ul className="checklist">
            <li className={photos > 0 ? 'ok' : 'no'}>Foto kondisi barang ({photos})</li>
            <li className={videos > 0 ? 'ok' : needVideo ? 'no' : ''}>Video kondisi barang ({videos}){!needVideo && ' — opsional'}</li>
          </ul>
          {inspEv.length > 0 && <EvidenceGallery files={inspEv} />}
        </div>
      )}

      <div className="row">
        <AsyncButton disabled={!canSubmit} confirm={isClaim ? `Kirim inspeksi: ${DECISION_LABEL[decision]} — ditolak ${num(rejected, 3)} ${o.unit}. Klaim retur akan dibuat.` : 'Terima barang penuh? Order akan disettle.'} onClick={async () => {
          const body = compact({
            decision, accepted_quantity: decision === 'PARTIAL_ACCEPT' ? acc : '',
            reason_code: isClaim ? f.reason_code : '', description: isClaim ? f.description : '',
            measured_weight_kg: isClaim && f.measured_weight_kg !== '' ? Number(f.measured_weight_kg) : '',
            measured_temperature_c: isClaim && f.measured_temperature_c !== '' ? Number(f.measured_temperature_c) : '',
            notes: f.notes,
          });
          const r = await api.post(`/api/orders/${o.id}/inspection`, body);
          setResult(r);
          if (r.return_case?.id) onReturn(r.return_case.id); else await reload();
        }}>{isClaim ? 'Kirim inspeksi & ajukan klaim' : 'Terima barang'}</AsyncButton>
        {!evidenceOk && <small className="inline-error">Unggah foto{needVideo ? ' dan video' : ''} kondisi barang terlebih dahulu.</small>}
        {partialInvalid && <small className="inline-error">Kuantitas diterima harus 0 &lt; x &lt; {num(qty, 3)}.</small>}
      </div>
      {result && !result.return_case && <Alert kind="success">Inspeksi tersimpan. Status order: {ORDER_STATUS_LABEL[result.order?.status] ?? result.order?.status}.</Alert>}
    </div>
  );
}
