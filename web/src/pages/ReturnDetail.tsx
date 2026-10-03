import { ReactElement, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, attributeRows, d, dt, FAULT_LABEL, num, pct, RETURN_STATUS_LABEL, rupiah } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, AsyncButton, Badge, Card, Empty, EvidenceGallery, Field, statusTone, Timeline, useAsync } from '../components/ui';
import { BEARER_LABEL, compact, COMPONENT_LABEL, fmtVal, KV, shipmentEventItems } from './buyer/shared';

const CHECK_LABEL: Record<string, string> = {
  has_photo: 'Ada foto penerimaan', has_video: 'Ada video penerimaan', video_ok: 'Syarat video terpenuhi', within_claim_window: 'Dalam jendela waktu klaim',
  quantity_valid: 'Kuantitas klaim valid', reason_active: 'Alasan klaim aktif', supplier_declaration_exists: 'Deklarasi supplier tersedia',
};
const DISPUTE_LABEL: Record<string, string> = { OPEN: 'Dibuka', UNDER_REVIEW: 'Ditinjau', RESOLVED: 'Selesai' };
const DECISION_LABEL: Record<string, string> = { ACCEPT: 'Diterima penuh', PARTIAL_ACCEPT: 'Diterima sebagian', REJECT: 'Ditolak', APPROVED: 'Disetujui', PARTIALLY_APPROVED: 'Disetujui sebagian', REJECTED: 'Ditolak' };
const MODE_LABEL: Record<string, string> = { PRORATA: 'Prorata', FULL: 'Penuh', NONE: 'Tidak direfund', PRO_RATA: 'Prorata' };
const SHIPMENT_STATUS_LABEL: Record<string, string> = { SCHEDULED: 'Dijadwalkan', PICKED_UP: 'Diambil', IN_TRANSIT: 'Dalam perjalanan', ARRIVED: 'Tiba', DELIVERED: 'Terkirim', RECEIVED: 'Diterima' };

export default function ReturnDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const role = user?.role ?? 'BUYER';
  const { data, error, loading, reload } = useAsync<any>(() => api.get(`/api/returns/${id}`), [id]);
  const [decided, setDecided] = useState<any>(null);

  if (loading && !data) return <p className="muted">Memuat kasus retur…</p>;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;

  const rc = data.case; const o = data.order; const bd = data.before_delivery ?? {}; const dl = data.delivery ?? {}; const ar = data.at_receiving ?? {};
  const elig = rc.eligibility;
  const adj = (data.adjustments ?? [])[0];
  const comp = adj?.components ?? null;
  const rs = data.return_shipment;
  const declared = bd.declared ?? {};
  const unit = o?.unit ?? '';

  return (
    <>
      <div className="page-head">
        <div>
          <small className="muted"><Link to="/returns">Retur</Link> / {rc.case_no}</small>
          <h1>{rc.case_no} <Badge tone={statusTone(rc.status)}>{RETURN_STATUS_LABEL[rc.status] ?? rc.status}</Badge></h1>
          <p>
            Order <Link to={`/orders/${o.id}`}><b>{o.order_no}</b></Link> · {declared.product_name} · alasan: <b>{rc.reason_label ?? rc.reason_code}</b>
            <br />Kuantitas terdampak: <b>{num(rc.quantity_affected, 3)} {unit}</b> dari {num(o.quantity, 3)} {unit}
            {rc.approved_quantity != null && rc.decided_at && <> · disetujui <b>{num(rc.approved_quantity, 3)} {unit}</b></>}
            {rc.fault_attribution && <> · atribusi: <Badge>{FAULT_LABEL[rc.fault_attribution] ?? rc.fault_attribution}</Badge></>}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}><small className="muted">diajukan {dt(rc.created_at)}</small>{rc.decided_at && <><br /><small className="muted">diputus {dt(rc.decided_at)}</small></>}</div>
      </div>

      <div className="grid cols-2">
        <Card title="Eligibility check (otomatis)">
          {!elig ? <Empty>Belum ada hasil pemeriksaan otomatis.</Empty> : (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <Badge tone={elig.eligible ? 'good' : 'bad'}>{elig.eligible ? 'Memenuhi syarat review' : 'Tidak memenuhi syarat'}</Badge>
                <small className="muted">diperiksa {dt(elig.checked_at)}</small>
              </div>
              <ul className="checklist">
                {Object.entries(elig.checks ?? {}).map(([k, v]) => <li key={k} className={v ? 'ok' : 'no'}>{CHECK_LABEL[k] ?? k}</li>)}
              </ul>
              <small className="muted">{elig.note}</small>
            </>
          )}
        </Card>
        <Card title="Sinyal untuk dipertimbangkan (bukan kesimpulan)">
          {!(data.signals ?? []).length ? <p className="muted">Tidak ada sinyal anomali terdeteksi dari data.</p> : (
            <ul>{data.signals.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
          )}
          <Alert kind="info">{data.guidance}</Alert>
          <small className="muted">Kemungkinan sumber: {(data.possible_sources ?? []).map((s: string) => FAULT_LABEL[s] ?? s).join(', ')}.</small>
        </Card>
      </div>

      <Card title="Perbandingan bukti: deklarasi supplier → pengiriman → penerimaan buyer">
        <div className="compare">
          <div className="col">
            <h4>Before delivery — deklarasi supplier</h4>
            <EvidenceGallery files={bd.supplier_photos ?? []} emptyText="Supplier tidak memiliki foto deklarasi." />
            <div style={{ marginTop: 10 }}>
              <KV rows={[
                ['Produk', declared.product_name], ['Grade', declared.grade], ['Kuantitas', declared.quantity != null ? `${num(declared.quantity, 3)} ${unit}` : '-'],
                ['Berat diharapkan (kg)', fmtVal(declared.expected_weight_kg)], ['Tanggal panen', d(declared.harvest_date)], ['Kondisi', declared.condition],
                ['Ukuran', declared.size], ['Warna', declared.color], ['Kesegaran', declared.freshness], ['Suhu (°C)', fmtVal(declared.temperature_c)],
                ...attributeRows(declared.attribute_schema, declared.attributes, fmtVal),
              ]} />
            </div>
            <div style={{ marginTop: 10 }}>
              <b>Deklarasi</b>
              {bd.declaration ? <KV rows={[['Versi', bd.declaration.declaration_version], ['Disetujui', dt(bd.declaration.accepted_at)]]} /> : <p className="muted">Tidak ada persetujuan deklarasi.</p>}
            </div>
            {bd.harvest && (
              <div style={{ marginTop: 10 }}>
                <b>Panen (perkiraan vs aktual)</b>
                <KV rows={[
                  ['Tahap', bd.harvest.stage], ['Perkiraan panen', d(bd.harvest.expected_harvest_date)], ['Panen aktual', d(bd.harvest.actual_harvest_date)],
                  ['Perkiraan kuantitas', fmtVal(bd.harvest.expected_quantity)], ['Kuantitas aktual', fmtVal(bd.harvest.actual_quantity)],
                  ['Perkiraan grade', bd.harvest.expected_grade], ['Grade aktual', bd.harvest.actual_grade], ['Kondisi aktual', bd.harvest.actual_condition],
                ]} />
              </div>
            )}
          </div>
          <div className="arrow">→</div>
          <div className="col">
            <h4>Delivery</h4>
            <KV rows={[
              ['Pickup', dt(dl.pickup_timestamp)], ['Tiba', dt(dl.arrived_timestamp)], ['Durasi', dl.duration_hours != null ? `${num(dl.duration_hours, 1)} jam` : '-'],
              ['Kurir', dl.carrier], ['Kemasan', dl.packaging], ['Cold chain', dl.cold_chain ? 'Ya' : 'Tidak'],
            ]} />
            {(dl.route ?? []).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <b>Rute</b>
                <ol style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {dl.route.map((r: any, i: number) => <li key={i}>{r.location ?? '(tanpa lokasi)'} <small className="muted">{dt(r.at)}</small></li>)}
                </ol>
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <b>Event tracking</b>
              {(dl.events ?? []).length ? <Timeline items={shipmentEventItems(dl.events)} /> : <p className="muted">Tidak ada event.</p>}
            </div>
          </div>
          <div className="arrow">→</div>
          <div className="col">
            <h4>At receiving — bukti buyer</h4>
            <EvidenceGallery files={[...(ar.buyer_photos ?? []), ...(ar.buyer_videos ?? [])]} emptyText="Buyer belum mengunggah bukti." />
            <div style={{ marginTop: 10 }}>
              <KV rows={[
                ['Waktu inspeksi', dt(ar.timestamp)], ['Keputusan inspeksi', DECISION_LABEL[ar.decision] ?? ar.decision],
                ['Kerusakan dilaporkan', ar.reported_damage ?? ar.reason_code], ['Kuantitas terdampak', `${num(ar.quantity_affected, 3)} ${unit}`],
                ['Deskripsi', ar.description], ['Berat terukur (kg)', fmtVal(ar.measured_weight_kg)], ['Suhu terukur (°C)', fmtVal(ar.measured_temperature_c)],
                ['Foto / video', `${(ar.buyer_photos ?? []).length} / ${(ar.buyer_videos ?? []).length}`],
              ]} />
            </div>
          </div>
        </div>
      </Card>

      <div className="grid cols-2">
        <Card title="Dispute">
          {!data.dispute ? <Empty>Belum ada dispute / pernyataan pihak.</Empty> : (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <Badge tone={data.dispute.status === 'RESOLVED' ? 'good' : 'bad'}>{DISPUTE_LABEL[data.dispute.status] ?? data.dispute.status}</Badge>
                <small className="muted">dibuka oleh {data.dispute.opened_by} · {dt(data.dispute.created_at)}</small>
              </div>
              <KV rows={[
                ['Pernyataan supplier', data.dispute.supplier_statement ?? <span className="muted">-</span>],
                ['Pernyataan buyer', data.dispute.buyer_statement ?? <span className="muted">-</span>],
              ]} />
              {data.dispute.resolution && (
                <div style={{ marginTop: 8 }}>
                  <b>Resolusi</b> <small className="muted">{dt(data.dispute.resolved_at)}</small>
                  <KV rows={[
                    ['Keputusan', DECISION_LABEL[data.dispute.resolution.decision] ?? data.dispute.resolution.decision],
                    ['Kuantitas disetujui', fmtVal(data.dispute.resolution.approved_quantity)],
                    ['Atribusi', FAULT_LABEL[data.dispute.resolution.fault_attribution] ?? data.dispute.resolution.fault_attribution],
                    ['Catatan', data.dispute.resolution.notes],
                  ]} />
                </div>
              )}
            </>
          )}
          {rc.decision_notes && <p style={{ marginTop: 8 }}><b>Catatan keputusan admin:</b> {rc.decision_notes}</p>}
        </Card>

        <Card title="Financial adjustment">
          {!adj ? <Empty>Belum ada penyesuaian finansial (menunggu keputusan).</Empty> : <AdjustmentView row={adj} comp={comp} />}
        </Card>
      </div>

      {rs && (
        <Card title={<>Pengiriman retur <Badge>{SHIPMENT_STATUS_LABEL[rs.status] ?? rs.status}</Badge></>}>
          <KV rows={[['Tracking', rs.tracking_no], ['Kurir', rs.carrier], ['Driver', rs.driver_name], ['Kendaraan', rs.vehicle], ['Pickup', dt(rs.pickup_at)], ['Diterima supplier', dt(rs.arrived_at)], ['Biaya logistik retur', rupiah(rs.logistics_cost)]]} />
          <div style={{ marginTop: 8 }}>{(rs.events ?? []).length ? <Timeline items={shipmentEventItems(rs.events)} /> : <Empty>Belum ada event.</Empty>}</div>
        </Card>
      )}

      <ReturnActions rc={rc} role={role} rs={rs} reload={reload} onDecided={setDecided} />

      {decided && (
        <Card title="Hasil keputusan">
          <Alert kind="success">Keputusan tersimpan: {DECISION_LABEL[decided.return_case?.status] ?? decided.return_case?.status}.</Alert>
          {decided.adjustment ? <AdjustmentView row={decided.adjustment.adjustment} comp={decided.adjustment.computed} netRefund={decided.adjustment.netRefund} /> : <p className="muted">Klaim ditolak — tidak ada refund; hak supplier penuh.</p>}
        </Card>
      )}
    </>
  );
}

function AdjustmentView({ row, comp, netRefund }: { row: any; comp: any; netRefund?: number }) {
  const components: any[] = comp?.components ?? [];
  const rl = comp?.returnLogistics;
  return (
    <>
      <div className="stats">
        <div className="stat good"><div className="stat-label">Refund ke buyer</div><div className="stat-value">{rupiah(row?.refund_to_buyer ?? comp?.refundToBuyer)}</div>{netRefund != null && <div className="stat-hint">net setelah logistik retur: {rupiah(netRefund)}</div>}</div>
        <div className="stat"><div className="stat-label">Potongan supplier</div><div className="stat-value">{rupiah(row?.supplier_deduction ?? comp?.supplierDeduction)}</div></div>
        <div className="stat"><div className="stat-label">Ditanggung platform</div><div className="stat-value">{rupiah(row?.platform_absorbed ?? comp?.platformAbsorbed)}</div></div>
        <div className="stat"><div className="stat-label">Recovery logistik</div><div className="stat-value">{rupiah(row?.logistics_recovery ?? comp?.logisticsRecovery)}</div></div>
        <div className="stat"><div className="stat-label">Pembalikan pajak</div><div className="stat-value">{rupiah(row?.tax_reversal ?? comp?.taxReversal)}</div></div>
      </div>
      {comp?.ratio != null && <p className="muted">Rasio kuantitas disetujui / kuantitas order: {pct(Number(comp.ratio) * 100)}</p>}
      {components.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Komponen</th><th>Mode</th><th className="num">Basis</th><th className="num">Refund</th><th className="num">Pembalikan pajak</th><th>Ditanggung</th></tr></thead>
          <tbody>{components.map((c, i) => (
            <tr key={i}><td>{COMPONENT_LABEL[c.component] ?? c.component}</td><td>{MODE_LABEL[c.mode] ?? c.mode}</td><td className="num">{rupiah(c.base)}</td><td className="num">{rupiah(c.refund)}</td><td className="num">{rupiah(c.taxReversal)}</td><td>{c.bearer ? BEARER_LABEL[c.bearer] ?? c.bearer : '-'}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {rl && (
        <div style={{ marginTop: 10 }}>
          <b>Logistik retur</b>
          <KV rows={[
            ['Biaya', rupiah(rl.cost)], ['Ditanggung', BEARER_LABEL[rl.bearer] ?? rl.bearer],
            ['Alokasi', Object.entries(rl.allocation ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${BEARER_LABEL[k] ?? k}: ${rupiah(v as number)}`).join(' · ') || '-'],
          ]} />
        </div>
      )}
      {row?.created_at && <small className="muted">dicatat {dt(row.created_at)} · tipe {row.adjustment_type}</small>}
    </>
  );
}

// ----------------------------------------------------------------------------
// TINDAKAN PER PERAN
// ----------------------------------------------------------------------------
function ReturnActions({ rc, role, rs, reload, onDecided }: { rc: any; role: string; rs: any; reload: () => Promise<void>; onDecided: (r: any) => void }) {
  const [statement, setStatement] = useState('');
  const [dec, setDec] = useState({ decision: 'APPROVED', approved_quantity: '', fault_attribution: 'UNDETERMINED', notes: '', return_logistics_cost: '' });
  const [pickup, setPickup] = useState({ carrier: 'Supplier.id Logistics Partner', driver_name: '', vehicle: '' });
  const [ev, setEv] = useState({ event_type: 'CHECKPOINT', location: '', temperature_c: '', note: '' });
  const [receiveNotes, setReceiveNotes] = useState('');

  const s = rc.status;
  const items: ReactElement[] = [];
  const openForDispute = ['REQUESTED', 'EVIDENCE_REVIEW'].includes(s);
  const qtyAff = Number(rc.quantity_affected);
  const appr = Number(dec.approved_quantity);
  const partialInvalid = dec.decision === 'PARTIALLY_APPROVED' && !(appr > 0 && appr < qtyAff);

  if ((role === 'SUPPLIER' || role === 'BUYER') && openForDispute) items.push(
    <div key="dispute">
      <h4 style={{ margin: '0 0 6px' }}>{role === 'SUPPLIER' ? 'Ajukan dispute / pernyataan supplier' : 'Tambah pernyataan buyer'}</h4>
      <p className="muted">Pernyataan Anda akan dipertimbangkan Admin bersama bukti foto/video dan data pengiriman. Minimal 5 karakter.</p>
      <textarea rows={4} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={role === 'SUPPLIER' ? 'Jelaskan mengapa Anda tidak setuju dengan klaim ini…' : 'Tambahkan keterangan pendukung klaim Anda…'} />
      <div style={{ marginTop: 8 }}>
        <AsyncButton className="btn warn" disabled={statement.trim().length < 5} onClick={async () => { await api.post(`/api/returns/${rc.id}/dispute`, { statement: statement.trim() }); setStatement(''); await reload(); }}>Kirim pernyataan</AsyncButton>
      </div>
    </div>,
  );

  if (role === 'ADMIN' && openForDispute && !rc.decided_at) items.push(
    <div key="decide">
      <h4 style={{ margin: '0 0 6px' }}>Keputusan admin</h4>
      <Alert kind="warn">Tentukan atribusi berdasarkan perbandingan bukti di atas — bukan asumsi. Keputusan memicu financial adjustment &amp; ledger secara otomatis.</Alert>
      <div className="row" style={{ marginBottom: 10 }}>
        {['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'].map((k) => (
          <label key={k} className="row"><input type="radio" name="decision" checked={dec.decision === k} onChange={() => setDec({ ...dec, decision: k })} /> {DECISION_LABEL[k]}</label>
        ))}
      </div>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        {dec.decision === 'PARTIALLY_APPROVED' && (
          <Field label="Kuantitas disetujui" required hint={`0 < x < ${num(qtyAff, 3)}`}>
            <input type="number" min={0} max={qtyAff} step="any" value={dec.approved_quantity} onChange={(e) => setDec({ ...dec, approved_quantity: e.target.value })} />
          </Field>
        )}
        <Field label="Atribusi penyebab" required>
          <select value={dec.fault_attribution} onChange={(e) => setDec({ ...dec, fault_attribution: e.target.value })}>
            {Object.entries(FAULT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Biaya logistik retur (Rp)" hint="Kosongkan: default dihitung sistem dari konfigurasi">
          <input type="number" min={0} step="any" value={dec.return_logistics_cost} onChange={(e) => setDec({ ...dec, return_logistics_cost: e.target.value })} disabled={dec.decision === 'REJECTED'} />
        </Field>
        <Field label="Catatan keputusan" required hint="Minimal 3 karakter — dasar keputusan berdasarkan bukti">
          <input value={dec.notes} onChange={(e) => setDec({ ...dec, notes: e.target.value })} />
        </Field>
        <div className="form-actions">
          <AsyncButton disabled={partialInvalid || dec.notes.trim().length < 3} confirm={`Simpan keputusan ${DECISION_LABEL[dec.decision]} dengan atribusi ${FAULT_LABEL[dec.fault_attribution]}? Tidak dapat diubah.`} onClick={async () => {
            const r = await api.post(`/api/returns/${rc.id}/decide`, compact({
              decision: dec.decision, approved_quantity: dec.decision === 'PARTIALLY_APPROVED' ? appr : '',
              fault_attribution: dec.fault_attribution, notes: dec.notes.trim(),
              return_logistics_cost: dec.return_logistics_cost !== '' ? Number(dec.return_logistics_cost) : '',
            }));
            onDecided(r);
            await reload();
          }}>Simpan keputusan</AsyncButton>
          {partialInvalid && <small className="inline-error">Kuantitas disetujui harus 0 &lt; x &lt; {num(qtyAff, 3)}.</small>}
        </div>
      </form>
    </div>,
  );

  if (['APPROVED', 'PARTIALLY_APPROVED'].includes(s)) items.push(
    <form key="pickup" className="inline" onSubmit={(e) => e.preventDefault()}>
      <h4 style={{ gridColumn: '1 / -1', margin: 0 }}>Jadwalkan pickup retur</h4>
      <Field label="Kurir" required><input value={pickup.carrier} onChange={(e) => setPickup({ ...pickup, carrier: e.target.value })} /></Field>
      <Field label="Nama driver"><input value={pickup.driver_name} onChange={(e) => setPickup({ ...pickup, driver_name: e.target.value })} /></Field>
      <Field label="Kendaraan / plat"><input value={pickup.vehicle} onChange={(e) => setPickup({ ...pickup, vehicle: e.target.value })} /></Field>
      <div className="form-actions"><AsyncButton onClick={async () => { await api.post(`/api/returns/${rc.id}/pickup`, compact(pickup)); await reload(); }}>Jadwalkan pickup retur</AsyncButton></div>
    </form>,
  );

  if (['PICKUP_SCHEDULED', 'IN_TRANSIT'].includes(s) && (role === 'ADMIN' || role === 'SUPPLIER')) {
    if (rs) items.push(
      <form key="track" className="inline" onSubmit={(e) => e.preventDefault()}>
        <h4 style={{ gridColumn: '1 / -1', margin: 0 }}>Event tracking retur — {rs.tracking_no}</h4>
        <Field label="Jenis event">
          <select value={ev.event_type} onChange={(e) => setEv({ ...ev, event_type: e.target.value })}>
            <option value="CHECKPOINT">Checkpoint</option><option value="TEMPERATURE">Pembacaan suhu</option><option value="DELAY">Keterlambatan</option>
          </select>
        </Field>
        <Field label="Lokasi"><input value={ev.location} onChange={(e) => setEv({ ...ev, location: e.target.value })} /></Field>
        <Field label="Suhu (°C)"><input type="number" step="any" value={ev.temperature_c} onChange={(e) => setEv({ ...ev, temperature_c: e.target.value })} /></Field>
        <Field label="Catatan"><input value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} /></Field>
        <div className="form-actions">
          <AsyncButton className="btn secondary" onClick={async () => {
            await api.post(`/api/shipments/${rs.id}/events`, compact({ event_type: ev.event_type, location: ev.location, temperature_c: ev.temperature_c === '' ? '' : Number(ev.temperature_c), note: ev.note }));
            setEv({ ...ev, location: '', temperature_c: '', note: '' });
            await reload();
          }}>Catat event</AsyncButton>
        </div>
      </form>,
    );
    items.push(
      <form key="receive" className="inline" onSubmit={(e) => e.preventDefault()}>
        <h4 style={{ gridColumn: '1 / -1', margin: 0 }}>Konfirmasi retur diterima supplier</h4>
        <Field label="Catatan penerimaan"><input value={receiveNotes} onChange={(e) => setReceiveNotes(e.target.value)} placeholder="Kondisi barang retur saat diterima" /></Field>
        <div className="form-actions">
          <AsyncButton confirm="Konfirmasi barang retur telah diterima? Kasus ditutup dan order disettle." onClick={async () => { await api.post(`/api/returns/${rc.id}/receive`, compact({ notes: receiveNotes })); await reload(); }}>Konfirmasi retur diterima</AsyncButton>
        </div>
      </form>,
    );
  }

  if (!items.length) return null;
  return <Card title="Tindakan">{items.map((it, i) => <div key={i} style={i ? { borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 } : undefined}>{it}</div>)}</Card>;
}
