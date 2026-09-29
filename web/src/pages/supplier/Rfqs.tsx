import { FormEvent, Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupiah, num, dt, d, errMsg, BATCH_STATUS_LABEL } from '../../lib/api';
import { Card, Badge, statusTone, Alert, Field, Empty, AsyncButton, useAsync } from '../../components/ui';
import { compact } from './shared';

const RFQ_STATUS_LABEL: Record<string, string> = { OPEN: 'Terbuka', QUOTED: 'Ada penawaran', ACCEPTED: 'Disepakati', CLOSED: 'Ditutup', CANCELLED: 'Dibatalkan', EXPIRED: 'Kedaluwarsa' };
const QUOTE_STATUS_LABEL: Record<string, string> = { PENDING: 'Menunggu', COUNTERED: 'Di-counter', ACCEPTED: 'Diterima', REJECTED: 'Ditolak', EXPIRED: 'Kedaluwarsa' };
const LISTED = ['READY_FOR_ORDER', 'UPCOMING', 'PRE_HARVEST_UPDATED'];

function QuoteForm({ rfq, batches, onDone }: { rfq: any; batches: any[]; onDone: () => Promise<void> }) {
  const [f, setF] = useState<any>({ batch_id: '', price_per_unit: rfq.target_price ?? '', quantity: rfq.quantity ?? '', message: '', valid_until: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const batch = batches.find((b) => b.id === f.batch_id);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post(`/api/rfqs/${rfq.id}/quotations`, { ...compact(f), valid_until: f.valid_until ? new Date(f.valid_until).toISOString() : undefined });
      setF({ batch_id: '', price_per_unit: rfq.target_price ?? '', quantity: rfq.quantity ?? '', message: '', valid_until: '' });
      await onDone();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  if (!batches.length) return <Alert kind="warn">Tidak ada batch aktif (Siap dipesan / Akan panen) untuk ditawarkan. <Link to="/supplier/products">Publikasikan batch</Link> terlebih dahulu.</Alert>;
  return (
    <form className="inline" onSubmit={submit}>
      <Field label="Batch yang ditawarkan" required>
        <select required value={f.batch_id} onChange={(e) => set('batch_id', e.target.value)}>
          <option value="">— pilih batch —</option>
          {batches.map((b) => <option key={b.id} value={b.id}>{b.batch_code} — {b.product_name} ({b.grade ?? 'grade -'}, tersedia {num(b.available_quantity, 2)} {b.unit}, {BATCH_STATUS_LABEL[b.status] ?? b.status})</option>)}
        </select>
      </Field>
      <Field label={`Harga per ${rfq.unit ?? 'satuan'} (Rp)`} required hint={batch ? `Harga listing: ${rupiah(batch.price_per_unit)}` : rfq.target_price ? `Target buyer: ${rupiah(rfq.target_price)}` : undefined}>
        <input type="number" min={1} required value={f.price_per_unit} onChange={(e) => set('price_per_unit', e.target.value)} />
      </Field>
      <Field label={`Kuantitas (${rfq.unit ?? ''})`} required hint={`Diminta: ${num(rfq.quantity, 2)}`}>
        <input type="number" step="any" min={0} required value={f.quantity} onChange={(e) => set('quantity', e.target.value)} />
      </Field>
      <Field label="Berlaku sampai"><input type="datetime-local" value={f.valid_until} onChange={(e) => set('valid_until', e.target.value)} /></Field>
      <Field label="Pesan"><input value={f.message} onChange={(e) => set('message', e.target.value)} placeholder="cth. Harga sudah termasuk sortir grade A" /></Field>
      <div className="form-actions">
        <button className="btn" disabled={busy}>{busy ? '…' : 'Kirim penawaran'}</button>
        {err && <small className="inline-error">{err}</small>}
      </div>
    </form>
  );
}

function CounterForm({ quote, onDone }: { quote: any; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState<any>(quote.price_per_unit ?? '');
  const [qty, setQty] = useState<any>(quote.quantity ?? '');
  const [msg, setMsg] = useState('');
  if (!open) return <button className="btn secondary small" onClick={() => setOpen(true)}>Counter</button>;
  return (
    <div className="row" style={{ gap: 6 }}>
      <input style={{ width: 140 }} type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Harga/satuan" />
      <input style={{ width: 110 }} type="number" step="any" min={0} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" />
      <input style={{ width: 200 }} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Pesan" />
      <AsyncButton className="btn small" onClick={async () => { await api.post(`/api/quotations/${quote.id}/counter`, compact({ price_per_unit: price, quantity: qty, message: msg })); setOpen(false); await onDone(); }}>Kirim counter</AsyncButton>
      <button className="btn secondary small" onClick={() => setOpen(false)}>Batal</button>
    </div>
  );
}

function RfqDetail({ rfq, batches, onChanged }: { rfq: any; batches: any[]; onChanged: () => Promise<void> }) {
  const detail = useAsync<any>(() => api.get(`/api/rfqs/${rfq.id}`), [rfq.id]);
  const reload = async () => { await detail.reload(); await onChanged(); };
  const quotes: any[] = detail.data?.quotations ?? [];
  const open = ['OPEN', 'QUOTED'].includes(rfq.status);
  const hasPending = quotes.some((q) => q.status === 'PENDING');
  const accepted = quotes.find((q) => q.status === 'ACCEPTED');
  return (
    <div style={{ background: '#fafbfa', padding: 12, borderRadius: 8 }}>
      <div className="grid cols-2">
        <div>
          <h3>Detail permintaan</h3>
          <dl className="kv">
            <dt>No. RFQ</dt><dd>{rfq.rfq_no}</dd>
            <dt>Buyer</dt><dd>{rfq.buyer_name}{rfq.buyer_region ? ` — ${rfq.buyer_region}` : ''}</dd>
            <dt>Komoditas</dt><dd>{rfq.commodity}{rfq.required_grade ? ` · grade ${rfq.required_grade}` : ''}</dd>
            <dt>Kuantitas</dt><dd>{num(rfq.quantity, 2)} {rfq.unit}</dd>
            <dt>Target harga</dt><dd>{rfq.target_price ? `${rupiah(rfq.target_price)}/${rfq.unit}` : '-'}</dd>
            <dt>Dibutuhkan</dt><dd>{d(rfq.needed_by)}</dd>
            <dt>Pengiriman</dt><dd>{rfq.delivery_region ?? '-'}{rfq.delivery_address ? ` — ${rfq.delivery_address}` : ''} · {num(rfq.distance_km, 1)} km</dd>
          </dl>
        </div>
        <div>
          <h3>Riwayat penawaran &amp; negosiasi</h3>
          {detail.loading ? <p>Memuat…</p> : detail.error ? <Alert kind="error">{detail.error}</Alert> : quotes.length === 0 ? <Empty>Anda belum mengirim penawaran untuk RFQ ini.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ronde</th><th>Dari</th><th>Batch</th><th className="num">Harga</th><th className="num">Qty</th><th>Status</th><th>Pesan</th><th>Aksi</th></tr></thead>
                <tbody>
                  {quotes.map((qt) => (
                    <tr key={qt.id}>
                      <td>{qt.round}<br /><small>{dt(qt.created_at)}</small></td>
                      <td><Badge tone={qt.proposed_by === 'BUYER' ? 'warn' : ''}>{qt.proposed_by === 'BUYER' ? 'Buyer' : 'Anda'}</Badge></td>
                      <td>{qt.batch_code}<br /><small>{qt.product_name}</small></td>
                      <td className="num">{rupiah(qt.price_per_unit)}</td>
                      <td className="num">{num(qt.quantity, 2)}</td>
                      <td><Badge tone={statusTone(qt.status)}>{QUOTE_STATUS_LABEL[qt.status] ?? qt.status}</Badge>{qt.valid_until && <><br /><small>s.d. {dt(qt.valid_until)}</small></>}</td>
                      <td><small>{qt.message ?? '-'}</small></td>
                      <td>
                        {qt.status === 'PENDING' && qt.proposed_by === 'BUYER' && (
                          <div className="row" style={{ gap: 6 }}>
                            <AsyncButton className="btn small" confirm={`Terima penawaran buyer ${rupiah(qt.price_per_unit)}/${rfq.unit} × ${num(qt.quantity, 2)}? Order draft akan dibuat untuk buyer.`} onClick={async () => { await api.post(`/api/quotations/${qt.id}/accept`, {}); await reload(); }}>Terima</AsyncButton>
                            <CounterForm quote={qt} onDone={reload} />
                          </div>
                        )}
                        {qt.status === 'PENDING' && qt.proposed_by === 'SUPPLIER' && <small className="muted">Menunggu respons buyer</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {accepted && <Alert kind="success">Penawaran disepakati pada harga {rupiah(accepted.price_per_unit)}/{rfq.unit} — order draft telah dibuat; buyer melanjutkan konfirmasi &amp; pembayaran. Lihat di <Link to="/supplier/orders">Pesanan</Link>.</Alert>}
        </div>
      </div>
      {open && !hasPending && !accepted && (
        <div style={{ marginTop: 12 }}>
          <h3>{quotes.length ? 'Kirim penawaran baru' : 'Kirim penawaran'}</h3>
          <QuoteForm rfq={rfq} batches={batches} onDone={reload} />
        </div>
      )}
      {open && hasPending && quotes.some((q) => q.status === 'PENDING' && q.proposed_by === 'SUPPLIER') && <p className="muted" style={{ marginTop: 8 }}><small>Penawaran Anda masih menunggu respons buyer (terima atau counter).</small></p>}
      {!open && <p className="muted" style={{ marginTop: 8 }}><small>RFQ sudah {RFQ_STATUS_LABEL[rfq.status] ?? rfq.status} — tidak menerima penawaran baru.</small></p>}
    </div>
  );
}

export default function Rfqs() {
  const rfqQ = useAsync<any[]>(() => api.get('/api/rfqs'));
  const batchQ = useAsync<any[]>(() => api.get('/api/supplier/batches'));
  const [openId, setOpenId] = useState<string | null>(null);
  const [onlyMatched, setOnlyMatched] = useState(false);
  const rfqs = (rfqQ.data ?? []).filter((r) => !onlyMatched || r.matched);
  const batches = (batchQ.data ?? []).filter((b) => LISTED.includes(b.status));
  const sorted = [...rfqs].sort((a, b) => Number(!!b.matched) - Number(!!a.matched) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const matchedCount = (rfqQ.data ?? []).filter((r) => r.matched).length;
  const reload = async () => { await rfqQ.reload(); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>RFQ &amp; Penawaran</h1>
          <p>Permintaan penawaran dari buyer. RFQ yang cocok dengan listing aktif Anda (komoditas/kategori/batch) ditandai dan diurutkan teratas.</p>
        </div>
        <div className="row">
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={onlyMatched} onChange={(e) => setOnlyMatched(e.target.checked)} /> Hanya yang cocok ({matchedCount})</label>
          <button className="btn secondary small" onClick={reload}>Muat ulang</button>
        </div>
      </div>
      {(rfqQ.error || batchQ.error) && <Alert kind="error">{rfqQ.error || batchQ.error}</Alert>}
      <Card>
        {rfqQ.loading ? <p>Memuat…</p> : sorted.length === 0 ? <Empty>Belum ada RFQ terbuka.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>RFQ</th><th>Buyer</th><th>Komoditas</th><th className="num">Kuantitas</th><th className="num">Target harga</th><th>Dibutuhkan</th><th className="num">Jarak</th><th>Status</th><th className="num">Penawaran saya</th><th></th></tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <Fragment key={r.id}>
                    <tr style={r.matched ? { background: 'var(--brand-2)' } : undefined}>
                      <td><b>{r.rfq_no}</b>{r.matched && <><br /><Badge tone="good">Cocok dengan listing Anda</Badge></>}<br /><small>{dt(r.created_at)}</small></td>
                      <td>{r.buyer_name}<br /><small>{r.buyer_region ?? r.delivery_region ?? ''}</small></td>
                      <td>{r.commodity}{r.required_grade ? <><br /><small>grade {r.required_grade}</small></> : null}</td>
                      <td className="num">{num(r.quantity, 2)} {r.unit}</td>
                      <td className="num">{r.target_price ? rupiah(r.target_price) : '-'}</td>
                      <td>{d(r.needed_by)}</td>
                      <td className="num">{num(r.distance_km, 1)} km</td>
                      <td><Badge tone={statusTone(r.status)}>{RFQ_STATUS_LABEL[r.status] ?? r.status}</Badge></td>
                      <td className="num">{r.my_quotes}</td>
                      <td><button className="btn secondary small" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{openId === r.id ? 'Tutup' : r.my_quotes > 0 ? 'Negosiasi' : 'Tawarkan'}</button></td>
                    </tr>
                    {openId === r.id && (
                      <tr><td colSpan={10}><RfqDetail rfq={r} batches={batches} onChanged={reload} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="footer-note">Harga yang disepakati (accept) menjadi FINAL PRODUCT PRICE dan dikunci ke order draft; biaya platform, packaging, logistik, dan pajak dihitung pricing engine saat buyer konfirmasi.</p>
    </>
  );
}
