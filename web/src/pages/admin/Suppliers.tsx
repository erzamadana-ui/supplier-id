import { Fragment, useState } from 'react';
import { api, num, pct, dt } from '../../lib/api';
import { Card, Badge, statusTone, Alert, Field, AsyncButton, Empty, useAsync } from '../../components/ui';
import { PageHead, ORG_STATUS_LABEL, ORG_STATUSES, ENFORCEMENT_ACTION_LABEL, SUPPLIER_KIND_LABEL } from './shared';

const METRICS: [string, string, boolean][] = [
  // key, label, invert (true = nilai tinggi buruk)
  ['buyer_acceptance_rate', 'Tingkat penerimaan buyer', false], ['return_rate', 'Tingkat retur', true], ['returned_qty_rate', 'Rasio kuantitas diretur', true], ['damage_rate', 'Tingkat kerusakan', true],
  ['quality_mismatch_rate', 'Ketidaksesuaian kualitas', true], ['weight_mismatch_rate', 'Ketidaksesuaian berat', true], ['late_fulfillment_rate', 'Keterlambatan pemenuhan', true],
  ['cancellation_rate', 'Pembatalan', true], ['dispute_rate', 'Dispute', true], ['declaration_accuracy', 'Akurasi deklarasi', false],
];
const scoreTone = (s: any) => (s == null ? 'muted' : Number(s) >= 80 ? 'good' : Number(s) >= 60 ? 'warn' : 'bad');

function MetricBadge({ v, invert }: { v: any; invert: boolean }) {
  const n = Number(v);
  if (v == null || isNaN(n)) return <span className="muted">-</span>;
  const tone = invert ? (n > 20 ? 'bad' : n > 10 ? 'warn' : 'good') : (n >= 90 ? 'good' : n >= 75 ? 'warn' : 'bad');
  return <Badge tone={tone}>{pct(n)}</Badge>;
}

function OrgActions({ o, onSaved, supplier }: { o: any; onSaved: () => Promise<void>; supplier: boolean }) {
  const [status, setStatus] = useState(o.status);
  const [verified, setVerified] = useState(!!o.verified);
  const [taxStatus, setTaxStatus] = useState(o.tax_status);
  const [reason, setReason] = useState('');
  const dirty = status !== o.status || verified !== !!o.verified || taxStatus !== o.tax_status;
  return (
    <form className="inline" onSubmit={(e) => e.preventDefault()}>
      {supplier && (
        <Field label="Status (override manual)">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>{ORG_STATUSES.map((s) => <option key={s} value={s}>{ORG_STATUS_LABEL[s]}</option>)}</select>
        </Field>
      )}
      <Field label="Status pajak"><select value={taxStatus} onChange={(e) => setTaxStatus(e.target.value)}><option value="PKP">PKP</option><option value="NON_PKP">NON_PKP</option></select></Field>
      {supplier && <Field label="Terverifikasi"><label className="row"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> verified</label></Field>}
      <Field label="Alasan" hint="Tersimpan di status_reason & audit log"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="form-actions">
        <AsyncButton className="btn small" disabled={!dirty} confirm={status === 'SUSPENDED' && o.status !== 'SUSPENDED' ? `Tangguhkan ${o.name}? Listing & penawaran akan dinonaktifkan.` : undefined} onClick={async () => {
          const body: any = {};
          if (status !== o.status) body.status = status;
          if (verified !== !!o.verified) body.verified = verified;
          if (taxStatus !== o.tax_status) body.tax_status = taxStatus;
          if (reason) body.reason = reason;
          await api.patch(`/api/admin/organizations/${o.id}`, body);
          setReason('');
          await onSaved();
        }}>Simpan</AsyncButton>
      </div>
    </form>
  );
}

export default function Suppliers() {
  const suppliers = useAsync(() => api.get('/api/admin/organizations?type=SUPPLIER'));
  const buyers = useAsync(() => api.get('/api/admin/organizations?type=BUYER'));
  const quality = useAsync(() => api.get('/api/admin/quality'));
  const [open, setOpen] = useState<string | null>(null);
  const [openBuyer, setOpenBuyer] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const qmap: Record<string, any> = Object.fromEntries((quality.data ?? []).map((r: any) => [r.supplier_id, r]));
  const reloadAll = async () => { await suppliers.reload(); await quality.reload(); };
  const rows: any[] = (suppliers.data ?? []).filter((o: any) => !filter || `${o.name} ${o.region ?? ''} ${o.status}`.toLowerCase().includes(filter.toLowerCase()));
  const counts = ORG_STATUSES.map((s) => [s, (suppliers.data ?? []).filter((o: any) => o.status === s).length] as const).filter(([, n]) => n > 0);

  return (
    <>
      <PageHead
        title="Supplier & Quality Score"
        desc="Skor kualitas dihitung dari riwayat order (bobot & ambang di Konfigurasi → Quality Score). Enforcement otomatis dapat di-override manual di sini."
        actions={<AsyncButton className="btn secondary" confirm="Hitung ulang skor untuk semua supplier?" onClick={async () => { await api.post('/api/admin/quality/recompute', {}); await reloadAll(); }}>Hitung ulang semua skor</AsyncButton>}
      />
      {suppliers.error && <Alert kind="error">{suppliers.error}</Alert>}
      {quality.error && <Alert kind="error">Gagal memuat quality score: {quality.error}</Alert>}

      <Card title={<>Supplier <small className="muted">({rows.length})</small></>} actions={<>{counts.map(([s, n]) => <Badge key={s} tone={statusTone(s)}>{ORG_STATUS_LABEL[s]}: {n}</Badge>)}<input placeholder="Cari nama / wilayah / status" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} /></>}>
        {suppliers.loading && <p>Memuat…</p>}
        {suppliers.data && !rows.length && <Empty />}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Supplier</th><th>Jenis</th><th>Wilayah</th><th>Pajak</th><th>Verifikasi</th><th>Status</th><th className="num">Quality score</th><th className="num">Order</th><th>Enforcement</th><th></th></tr></thead>
              <tbody>
                {rows.map((o: any) => {
                  const qrow = qmap[o.id];
                  const m = qrow?.metrics ?? {};
                  const enf = o.enforcement ?? qrow?.enforcement ?? {};
                  const isOpen = open === o.id;
                  return (
                    <Fragment key={o.id}>
                      <tr>
                        <td><b>{o.name}</b>{o.status_reason && <><br /><small className="muted">{o.status_reason}</small></>}</td>
                        <td>{SUPPLIER_KIND_LABEL[o.supplier_kind] ?? o.supplier_kind ?? '-'}</td>
                        <td>{o.region ?? '-'}</td>
                        <td><Badge>{o.tax_status}</Badge></td>
                        <td>{o.verified ? <Badge tone="good">Terverifikasi</Badge> : <Badge tone="warn">Belum</Badge>}</td>
                        <td><Badge tone={statusTone(o.status)}>{ORG_STATUS_LABEL[o.status] ?? o.status}</Badge></td>
                        <td className="num"><Badge tone={scoreTone(o.quality_score)}>{o.quality_score != null ? num(o.quality_score, 1) : 'belum dihitung'}</Badge></td>
                        <td className="num">{num(o.order_count)}</td>
                        <td>{(enf.actions ?? []).length ? (enf.actions as string[]).map((a) => <Badge key={a} tone="warn">{ENFORCEMENT_ACTION_LABEL[a] ?? a}</Badge>) : <span className="muted">{enf.note ?? '-'}</span>}</td>
                        <td><button type="button" className="btn small secondary" onClick={() => setOpen(isOpen ? null : o.id)}>{isOpen ? 'Tutup' : 'Detail'}</button></td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={10} style={{ background: '#fafbfa' }}>
                            <div className="grid cols-3">
                              <div>
                                <h3>Metrik kualitas</h3>
                                {!qrow ? <Empty>Skor belum pernah dihitung.</Empty> : (
                                  <table>
                                    <tbody>
                                      <tr><td>Total order</td><td className="num">{num(m.total_orders)}</td></tr>
                                      <tr><td>Order sukses</td><td className="num">{num(m.successful_orders)}</td></tr>
                                      {METRICS.map(([k, label, inv]) => <tr key={k}><td>{label}</td><td className="num"><MetricBadge v={m[k]} invert={inv} /></td></tr>)}
                                    </tbody>
                                  </table>
                                )}
                                <small className="muted">Dihitung: {dt(qrow?.computed_at)}</small>
                              </div>
                              <div>
                                <h3>Kontribusi skor (parts)</h3>
                                {!m.parts ? <Empty /> : (
                                  <table>
                                    <tbody>
                                      {Object.entries(m.parts as Record<string, number>).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td className="num">{num(v, 2)}</td></tr>)}
                                      <tr className="total"><td>Skor</td><td className="num">{num(qrow?.score, 2)}</td></tr>
                                    </tbody>
                                  </table>
                                )}
                                <div style={{ marginTop: 8 }}>
                                  <AsyncButton className="btn small secondary" onClick={async () => { await api.post('/api/admin/quality/recompute', { supplier_id: o.id }); await reloadAll(); }}>Hitung ulang skor</AsyncButton>
                                </div>
                                {enf.level && enf.level !== 'NONE' && <p style={{ marginTop: 8 }}><small>Enforcement otomatis: level <b>{enf.level}</b> → status <b>{ORG_STATUS_LABEL[enf.status] ?? enf.status}</b></small></p>}
                              </div>
                              <div>
                                <h3>Tindakan admin</h3>
                                <OrgActions o={o} supplier onSaved={reloadAll} />
                                <small className="muted">Rekening: {o.bank_account ?? '-'} · dibuat {dt(o.created_at)}</small>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={<>Buyer <small className="muted">({(buyers.data ?? []).length})</small></>}>
        {buyers.loading && <p>Memuat…</p>}
        {buyers.error && <Alert kind="error">{buyers.error}</Alert>}
        {buyers.data && !buyers.data.length && <Empty />}
        {(buyers.data ?? []).length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Buyer</th><th>Wilayah</th><th>Pajak</th><th>Status</th><th className="num">Order</th><th>Dibuat</th><th></th></tr></thead>
              <tbody>
                {(buyers.data ?? []).map((o: any) => (
                  <Fragment key={o.id}>
                    <tr>
                      <td><b>{o.name}</b></td>
                      <td>{o.region ?? '-'}</td>
                      <td><Badge>{o.tax_status}</Badge></td>
                      <td><Badge tone={statusTone(o.status)}>{ORG_STATUS_LABEL[o.status] ?? o.status}</Badge></td>
                      <td className="num">{num(o.order_count)}</td>
                      <td>{dt(o.created_at)}</td>
                      <td><button type="button" className="btn small secondary" onClick={() => setOpenBuyer(openBuyer === o.id ? null : o.id)}>{openBuyer === o.id ? 'Tutup' : 'Ubah'}</button></td>
                    </tr>
                    {openBuyer === o.id && <tr><td colSpan={7} style={{ background: '#fafbfa' }}><OrgActions o={o} supplier={false} onSaved={buyers.reload} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="footer-note">Status pajak (PKP/NON_PKP) memengaruhi aturan PPN komponen produk untuk order baru. Override status manual tidak menghentikan enforcement otomatis pada perhitungan skor berikutnya.</p>
    </>
  );
}
