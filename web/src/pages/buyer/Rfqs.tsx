import { ChangeEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, d, dt, errMsg, num, rupiah } from '../../lib/api';
import { Alert, AsyncButton, Badge, Card, Empty, Field, statusTone, useAsync } from '../../components/ui';
import { compact } from './shared';

const RFQ_STATUS_LABEL: Record<string, string> = { OPEN: 'Terbuka', QUOTED: 'Ada penawaran', ACCEPTED: 'Disepakati', CLOSED: 'Ditutup', CANCELLED: 'Dibatalkan' };
const QUOTE_STATUS_LABEL: Record<string, string> = { PENDING: 'Menunggu respons', COUNTERED: 'Di-counter', ACCEPTED: 'Diterima', REJECTED: 'Ditolak', EXPIRED: 'Kedaluwarsa' };
const rfqTone = (s: string) => (s === 'ACCEPTED' ? 'good' : s === 'QUOTED' ? 'warn' : ['CLOSED', 'CANCELLED'].includes(s) ? 'bad' : '');

const emptyForm = { category_id: '', batch_id: '', commodity: '', quantity: '', unit: 'KG', target_price: '', required_grade: '', delivery_address: '', delivery_region: '', distance_km: '0', needed_by: '' };

export default function Rfqs() {
  const [sp] = useSearchParams();
  const cats = useAsync<any[]>(() => api.get('/api/categories'), []);
  const list = useAsync<any[]>(() => api.get('/api/rfqs'), []);
  const [form, setForm] = useState({ ...emptyForm });
  const [showForm, setShowForm] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [created, setCreated] = useState('');

  // prefill dari query string (dari halaman listing UPCOMING)
  useEffect(() => {
    const batch_id = sp.get('batch_id') ?? '';
    const commodity = sp.get('commodity') ?? '';
    if (batch_id || commodity) {
      setForm((f) => ({ ...f, batch_id, commodity, category_id: sp.get('category_id') ?? f.category_id, unit: sp.get('unit') ?? f.unit }));
      setShowForm(true);
    }
    // eslint-disable-next-line
  }, []);

  const set = (k: keyof typeof emptyForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    const body = compact({
      ...form,
      quantity: Number(form.quantity), distance_km: Number(form.distance_km) || 0,
      target_price: form.target_price ? Number(form.target_price) : '',
    });
    const r = await api.post('/api/rfqs', body);
    setCreated(r.rfq_no);
    setForm({ ...emptyForm });
    setShowForm(false);
    await list.reload();
    setOpen(r.id);
  };

  return (
    <>
      <div className="page-head">
        <div><h1>RFQ saya</h1><p>Permintaan penawaran (Request for Quotation) dan negosiasi harga dengan supplier.</p></div>
        <button className="btn" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Tutup form' : 'Buat RFQ baru'}</button>
      </div>

      {created && <Alert kind="success">RFQ <b>{created}</b> berhasil dibuat. Supplier yang cocok akan melihat permintaan ini.</Alert>}

      {showForm && (
        <Card title="Buat RFQ">
          {form.batch_id && <Alert kind="info">RFQ ini ditautkan ke batch <code>{form.batch_id}</code> (dari halaman listing).</Alert>}
          <form className="inline" onSubmit={(e) => { e.preventDefault(); }}>
            <Field label="Kategori">
              <select value={form.category_id} onChange={set('category_id')}>
                <option value="">— pilih —</option>
                {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Komoditas" required><input value={form.commodity} onChange={set('commodity')} placeholder="mis. Beras" /></Field>
            <Field label="Kuantitas" required><input type="number" min={0} step="any" value={form.quantity} onChange={set('quantity')} /></Field>
            <Field label="Satuan" required><input value={form.unit} onChange={set('unit')} /></Field>
            <Field label="Target harga / satuan"><input type="number" min={0} step="any" value={form.target_price} onChange={set('target_price')} /></Field>
            <Field label="Grade yang diminta"><input value={form.required_grade} onChange={set('required_grade')} placeholder="mis. A" /></Field>
            <Field label="Alamat pengiriman"><input value={form.delivery_address} onChange={set('delivery_address')} /></Field>
            <Field label="Wilayah pengiriman"><input value={form.delivery_region} onChange={set('delivery_region')} placeholder="mis. Pekanbaru" /></Field>
            <Field label="Jarak (km)" required hint="Dipakai untuk estimasi biaya delivery saat penawaran diterima"><input type="number" min={0} step="any" value={form.distance_km} onChange={set('distance_km')} /></Field>
            <Field label="Dibutuhkan sebelum"><input type="date" value={form.needed_by} onChange={set('needed_by')} /></Field>
            <div className="form-actions">
              <AsyncButton disabled={!form.commodity || !(Number(form.quantity) > 0)} onClick={submit}>Kirim RFQ</AsyncButton>
              <button type="button" className="btn secondary" onClick={() => setShowForm(false)}>Batal</button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Daftar RFQ">
        {list.error && <Alert kind="error">{list.error}</Alert>}
        {list.loading && <p className="muted">Memuat…</p>}
        {!list.loading && !(list.data ?? []).length && <Empty>Belum ada RFQ. Buat RFQ agar supplier dapat mengirim penawaran.</Empty>}
        {(list.data ?? []).length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>No. RFQ</th><th>Komoditas</th><th className="num">Kuantitas</th><th className="num">Target harga</th><th>Wilayah</th><th>Dibutuhkan</th><th>Status</th><th className="num">Penawaran</th><th></th></tr></thead>
              <tbody>
                {(list.data ?? []).map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.rfq_no}</b><br /><small className="muted">{dt(r.created_at)}</small></td>
                    <td>{r.commodity}{r.required_grade ? <><br /><small className="muted">Grade {r.required_grade}</small></> : null}</td>
                    <td className="num">{num(r.quantity, 3)} {r.unit}</td>
                    <td className="num">{r.target_price != null ? rupiah(r.target_price) : '-'}</td>
                    <td>{r.delivery_region ?? '-'}<br /><small className="muted">{num(r.distance_km)} km</small></td>
                    <td>{d(r.needed_by)}</td>
                    <td><Badge tone={rfqTone(r.status)}>{RFQ_STATUS_LABEL[r.status] ?? r.status}</Badge></td>
                    <td className="num">{r.quote_count ?? 0}</td>
                    <td><button className="btn secondary small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Tutup' : 'Lihat penawaran'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <RfqDetail id={open} onChanged={() => list.reload()} />}
    </>
  );
}

function RfqDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const nav = useNavigate();
  const { data: r, error, loading, reload } = useAsync<any>(() => api.get(`/api/rfqs/${id}`), [id]);
  const [counter, setCounter] = useState<Record<string, { price: string; qty: string; message: string }>>({});

  if (loading) return <Card title="Penawaran"><p className="muted">Memuat…</p></Card>;
  if (error) return <Card title="Penawaran"><Alert kind="error">{error}</Alert></Card>;
  if (!r) return null;

  const quotes: any[] = r.quotations ?? [];
  const bySupplier = new Map<string, any[]>();
  for (const qt of quotes) {
    const k = qt.supplier_id;
    if (!bySupplier.has(k)) bySupplier.set(k, []);
    bySupplier.get(k)!.push(qt);
  }
  const rfqOpen = ['OPEN', 'QUOTED'].includes(r.status);

  return (
    <Card title={<>Penawaran untuk {r.rfq_no} <Badge tone={rfqTone(r.status)}>{RFQ_STATUS_LABEL[r.status] ?? r.status}</Badge></>} actions={<button className="btn secondary small" onClick={reload}>Muat ulang</button>}>
      <p className="muted">
        {r.commodity} · {num(r.quantity, 3)} {r.unit} · target {r.target_price != null ? rupiah(r.target_price) : '-'} · {r.delivery_region ?? '-'} ({num(r.distance_km)} km){r.needed_by ? ` · dibutuhkan ${d(r.needed_by)}` : ''}
      </p>
      {!quotes.length && <Empty>Belum ada penawaran dari supplier.</Empty>}
      {[...bySupplier.entries()].map(([sid, qs]) => (
        <div key={sid} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3>{qs[0].supplier_name}</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ronde</th><th>Diajukan oleh</th><th>Batch</th><th className="num">Harga / satuan</th><th className="num">Kuantitas</th><th>Pesan</th><th>Status</th><th>Waktu</th><th></th></tr></thead>
              <tbody>
                {qs.map((qt) => {
                  const actionable = rfqOpen && qt.status === 'PENDING' && qt.proposed_by === 'SUPPLIER';
                  const c = counter[qt.id] ?? { price: '', qty: '', message: '' };
                  return (
                    <tr key={qt.id}>
                      <td>#{qt.round}</td>
                      <td>{qt.proposed_by === 'SUPPLIER' ? 'Supplier' : 'Anda'}</td>
                      <td>{qt.batch_code}<br /><small className="muted">{qt.product_name}{qt.grade ? ` · Grade ${qt.grade}` : ''}</small></td>
                      <td className="num"><b>{rupiah(qt.price_per_unit)}</b></td>
                      <td className="num">{num(qt.quantity, 3)} {r.unit}</td>
                      <td>{qt.message ?? <span className="muted">-</span>}{qt.valid_until && <><br /><small className="muted">berlaku s.d. {dt(qt.valid_until)}</small></>}</td>
                      <td><Badge tone={qt.status === 'ACCEPTED' ? 'good' : qt.status === 'PENDING' ? 'warn' : qt.status === 'REJECTED' ? 'bad' : ''}>{QUOTE_STATUS_LABEL[qt.status] ?? qt.status}</Badge></td>
                      <td><small>{dt(qt.created_at)}</small></td>
                      <td>
                        {actionable && (
                          <div style={{ display: 'grid', gap: 6, minWidth: 220 }}>
                            <AsyncButton className="btn small" confirm={`Terima penawaran ${rupiah(qt.price_per_unit)}/${r.unit} × ${num(qt.quantity, 3)}? Order DRAFT akan dibuat.`} onClick={async () => {
                              const o = await api.post(`/api/quotations/${qt.id}/accept`, {});
                              onChanged();
                              nav(`/orders/${o.id}`);
                            }}>Terima penawaran</AsyncButton>
                            <details>
                              <summary style={{ cursor: 'pointer', fontSize: 12 }}>Counter-offer</summary>
                              <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                                <input type="number" min={0} step="any" placeholder="Harga / satuan" value={c.price} onChange={(e) => setCounter({ ...counter, [qt.id]: { ...c, price: e.target.value } })} />
                                <input type="number" min={0} step="any" placeholder={`Kuantitas (default ${num(qt.quantity, 3)})`} value={c.qty} onChange={(e) => setCounter({ ...counter, [qt.id]: { ...c, qty: e.target.value } })} />
                                <input placeholder="Pesan (opsional)" value={c.message} onChange={(e) => setCounter({ ...counter, [qt.id]: { ...c, message: e.target.value } })} />
                                <AsyncButton className="btn secondary small" disabled={!(Number(c.price) > 0)} onClick={async () => {
                                  try {
                                    await api.post(`/api/quotations/${qt.id}/counter`, compact({ price_per_unit: Number(c.price), quantity: c.qty ? Number(c.qty) : '', message: c.message }));
                                  } catch (e) { throw new Error(errMsg(e)); }
                                  setCounter({ ...counter, [qt.id]: { price: '', qty: '', message: '' } });
                                  await reload(); onChanged();
                                }}>Kirim counter</AsyncButton>
                              </div>
                            </details>
                          </div>
                        )}
                        {!actionable && qt.status === 'PENDING' && qt.proposed_by === 'BUYER' && <small className="muted">Menunggu respons supplier</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </Card>
  );
}
