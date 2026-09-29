import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rupiah, num, d, errMsg, BATCH_STATUS_LABEL } from '../../lib/api';
import { Card, Badge, statusTone, Alert, Field, Empty, useAsync } from '../../components/ui';
import { AttributeInputs, AttrField, compact, BATCH_TYPE_LABEL, HARVEST_STAGE_LABEL } from './shared';

const PRODUCT_STATUS_LABEL: Record<string, string> = { PENDING_DECLARATION: 'Belum dideklarasikan', ACTIVE: 'Aktif', UPCOMING_HARVEST: 'Akan panen', INACTIVE: 'Nonaktif' };
const UNITS = ['KG', 'TON', 'IKAT', 'KARUNG', 'BOX', 'PCS', 'LITER'];

function ProductForm({ categories, onCreated }: { categories: any[]; onCreated: () => Promise<any> }) {
  const [f, setF] = useState<any>({ category_id: '', name: '', commodity: '', variety: '', unit: 'KG', origin: '', production_method: '', certification: '' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setOk(''); setBusy(true);
    try {
      const row = await api.post('/api/supplier/products', compact(f));
      setOk(`Produk "${row.name}" dibuat. Lanjutkan dengan mendaftarkan barang (batch) di bawah.`);
      setF({ category_id: '', name: '', commodity: '', variety: '', unit: 'KG', origin: '', production_method: '', certification: '' });
      await onCreated();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <form className="inline" onSubmit={submit}>
      <Field label="Kategori" required>
        <select required value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
          <option value="">— pilih kategori —</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
        </select>
      </Field>
      <Field label="Nama produk" required><input required minLength={2} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="cth. Beras Premium Solok" /></Field>
      <Field label="Komoditas" required hint="Dipakai untuk mencocokkan RFQ buyer"><input required minLength={2} value={f.commodity} onChange={(e) => set('commodity', e.target.value)} placeholder="cth. Beras" /></Field>
      <Field label="Varietas"><input value={f.variety} onChange={(e) => set('variety', e.target.value)} placeholder="cth. Anak Daro" /></Field>
      <Field label="Satuan" required>
        <select value={f.unit} onChange={(e) => set('unit', e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
      </Field>
      <Field label="Asal / daerah"><input value={f.origin} onChange={(e) => set('origin', e.target.value)} placeholder="cth. Solok, Sumatera Barat" /></Field>
      <Field label="Metode produksi"><input value={f.production_method} onChange={(e) => set('production_method', e.target.value)} placeholder="cth. Konvensional / Organik" /></Field>
      <Field label="Sertifikasi"><input value={f.certification} onChange={(e) => set('certification', e.target.value)} placeholder="cth. Prima-3, Organik Indonesia" /></Field>
      <div className="form-actions">
        <button className="btn" disabled={busy}>{busy ? '…' : 'Tambah produk'}</button>
        {err && <small className="inline-error">{err}</small>}
        {ok && <small style={{ color: 'var(--good)' }}>{ok}</small>}
      </div>
    </form>
  );
}

const emptyBatch = () => ({
  product_id: '', type: 'READY_STOCK', grade: '', quantity: '', unit: 'KG', expected_weight_kg: '', weight_tolerance_pct: '2',
  harvest_date: '', availability_date: '', condition: '', size: '', color: '', freshness: '', moisture: '', temperature_c: '', shelf_life_days: '', expiry_date: '',
  price_per_unit: '',
});
const emptyHarvest = () => ({ planting_date: '', expected_harvest_date: '', expected_quantity: '', expected_grade: '', expected_quality: '', current_condition: '', forecast_confidence: '' });

function BatchForm({ products }: { products: any[] }) {
  const nav = useNavigate();
  const [f, setF] = useState<any>(emptyBatch());
  const [attrs, setAttrs] = useState<Record<string, any>>({});
  const [h, setH] = useState<any>(emptyHarvest());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const setH1 = (k: string, v: any) => setH((s: any) => ({ ...s, [k]: v }));
  const product = useMemo(() => products.find((p) => p.id === f.product_id), [products, f.product_id]);
  const schema: AttrField[] = product?.attribute_schema ?? [];
  const isHarvest = f.type === 'HARVEST';

  const chooseProduct = (id: string) => {
    const p = products.find((x) => x.id === id);
    setF((s: any) => ({ ...s, product_id: id, unit: p?.unit ?? s.unit }));
    setAttrs({});
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body: any = { ...compact(f), attributes: compact(attrs) };
      if (isHarvest) {
        body.harvest = compact(h);
        // quantity batch untuk panen = estimasi kuantitas jika tidak diisi terpisah
        if (!body.quantity && body.harvest?.expected_quantity) body.quantity = body.harvest.expected_quantity;
      }
      const row = await api.post('/api/supplier/batches', body);
      nav(`/supplier/batches/${row.id}`);
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  if (!products.length) return <Empty>Tambahkan produk terlebih dahulu sebelum mendaftarkan barang.</Empty>;

  return (
    <form className="inline" onSubmit={submit}>
      <Field label="Produk" required>
        <select required value={f.product_id} onChange={(e) => chooseProduct(e.target.value)}>
          <option value="">— pilih produk —</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.commodity} ({p.category_name})</option>)}
        </select>
      </Field>
      <div className="field">
        <span className="field-label">Jenis barang<em> *</em></span>
        <div className="row" style={{ paddingTop: 6 }}>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="btype" checked={f.type === 'READY_STOCK'} onChange={() => set('type', 'READY_STOCK')} /> Ready stock</label>
          <label className="row" style={{ gap: 4 }}><input type="radio" name="btype" checked={f.type === 'HARVEST'} onChange={() => set('type', 'HARVEST')} /> Panen / pre-order</label>
        </div>
      </div>

      <Field label="Grade" required={!isHarvest} hint={isHarvest ? 'Untuk panen, grade final diisi saat deklarasi final' : undefined}>
        <input value={f.grade} onChange={(e) => set('grade', e.target.value)} placeholder="cth. A / Premium / Super" />
      </Field>
      <Field label={isHarvest ? 'Kuantitas yang ditawarkan' : 'Kuantitas'} required={!isHarvest} hint={isHarvest ? 'Kosongkan untuk memakai estimasi hasil panen' : undefined}>
        <input type="number" step="any" min={0} required={!isHarvest} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} />
      </Field>
      <Field label="Satuan" required>
        <select value={f.unit} onChange={(e) => set('unit', e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
      </Field>
      <Field label="Harga per satuan (Rp)" required>
        <input type="number" min={1} step="1" required value={f.price_per_unit} onChange={(e) => set('price_per_unit', e.target.value)} />
      </Field>
      <Field label="Perkiraan berat total (kg)"><input type="number" step="any" min={0} value={f.expected_weight_kg} onChange={(e) => set('expected_weight_kg', e.target.value)} /></Field>
      <Field label="Toleransi berat (%)" hint="0–50; default 2%"><input type="number" step="0.1" min={0} max={50} value={f.weight_tolerance_pct} onChange={(e) => set('weight_tolerance_pct', e.target.value)} /></Field>
      {!isHarvest && (
        <>
          <Field label="Tanggal panen" hint="Wajib salah satu: tanggal panen atau tanggal tersedia"><input type="date" value={f.harvest_date} onChange={(e) => set('harvest_date', e.target.value)} /></Field>
          <Field label="Tanggal tersedia"><input type="date" value={f.availability_date} onChange={(e) => set('availability_date', e.target.value)} /></Field>
        </>
      )}
      <Field label="Kondisi" required={!isHarvest}><input value={f.condition} onChange={(e) => set('condition', e.target.value)} placeholder="cth. Segar, tanpa cacat, kering" /></Field>
      <Field label="Ukuran"><input value={f.size} onChange={(e) => set('size', e.target.value)} /></Field>
      <Field label="Warna"><input value={f.color} onChange={(e) => set('color', e.target.value)} /></Field>
      <Field label="Kesegaran"><input value={f.freshness} onChange={(e) => set('freshness', e.target.value)} placeholder="cth. Panen < 24 jam" /></Field>
      <Field label="Kelembapan / kadar air"><input value={f.moisture} onChange={(e) => set('moisture', e.target.value)} placeholder="cth. 13%" /></Field>
      <Field label="Suhu penyimpanan (°C)"><input type="number" step="any" value={f.temperature_c} onChange={(e) => set('temperature_c', e.target.value)} /></Field>
      <Field label="Umur simpan (hari)"><input type="number" step="1" min={0} value={f.shelf_life_days} onChange={(e) => set('shelf_life_days', e.target.value)} /></Field>
      <Field label="Tanggal kedaluwarsa"><input type="date" value={f.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} /></Field>

      {product && (
        <div style={{ gridColumn: '1 / -1' }}>
          <h3 style={{ marginTop: 6 }}>Atribut kualitas kategori {product.category_name}</h3>
          {schema.length === 0 ? <Empty>Kategori ini tidak memiliki atribut tambahan.</Empty> : (
            <div className="grid cols-3">
              <AttributeInputs schema={schema} value={attrs} onChange={setAttrs} />
            </div>
          )}
          {isHarvest && schema.some((s) => s.required) && <small className="muted">Untuk panen, atribut wajib dapat dilengkapi/diperbarui saat deklarasi final.</small>}
        </div>
      )}

      {isHarvest && (
        <div style={{ gridColumn: '1 / -1' }}>
          <h3 style={{ marginTop: 6 }}>Data panen (pre-order)</h3>
          <div className="grid cols-3">
            <Field label="Tanggal tanam"><input type="date" value={h.planting_date} onChange={(e) => setH1('planting_date', e.target.value)} /></Field>
            <Field label="Perkiraan tanggal panen" required><input type="date" required value={h.expected_harvest_date} onChange={(e) => setH1('expected_harvest_date', e.target.value)} /></Field>
            <Field label={`Estimasi kuantitas (${f.unit})`} required><input type="number" step="any" min={0} required value={h.expected_quantity} onChange={(e) => setH1('expected_quantity', e.target.value)} /></Field>
            <Field label="Perkiraan grade"><input value={h.expected_grade} onChange={(e) => setH1('expected_grade', e.target.value)} /></Field>
            <Field label="Perkiraan kualitas"><input value={h.expected_quality} onChange={(e) => setH1('expected_quality', e.target.value)} placeholder="cth. Bulir penuh, seragam" /></Field>
            <Field label="Kondisi tanaman saat ini"><input value={h.current_condition} onChange={(e) => setH1('current_condition', e.target.value)} placeholder="cth. Fase pengisian bulir, sehat" /></Field>
            <Field label="Keyakinan forecast (0–100)"><input type="number" min={0} max={100} step="1" value={h.forecast_confidence} onChange={(e) => setH1('forecast_confidence', e.target.value)} /></Field>
          </div>
        </div>
      )}

      <div className="form-actions">
        <button className="btn" disabled={busy}>{busy ? '…' : 'Daftarkan barang (simpan sebagai draft)'}</button>
        <small className="muted">Setelah tersimpan Anda akan diarahkan ke halaman batch untuk unggah foto bukti dan deklarasi.</small>
        {err && <small className="inline-error">{err}</small>}
      </div>
    </form>
  );
}

export default function Products() {
  const cats = useAsync<any[]>(() => api.get('/api/categories'));
  const prods = useAsync<any[]>(() => api.get('/api/supplier/products'));
  const batches = useAsync<any[]>(() => api.get('/api/supplier/batches'));
  const [tab, setTab] = useState<'list' | 'new'>('list');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Produk &amp; Batch</h1>
          <p>Alur: daftarkan produk → daftarkan barang (batch) → unggah foto bukti → deklarasi kualitas &amp; jaminan retur → terpublikasi.</p>
        </div>
      </div>

      {(cats.error || prods.error || batches.error) && <Alert kind="error">{cats.error || prods.error || batches.error}</Alert>}

      <Card title="Produk">
        {prods.loading ? <p>Memuat…</p> : !prods.data?.length ? <Empty>Belum ada produk. Tambahkan produk di bawah.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nama</th><th>Kategori</th><th>Komoditas / varietas</th><th>Satuan</th><th>Asal</th><th>Metode / sertifikasi</th><th>Status</th><th className="num">Batch</th></tr></thead>
              <tbody>
                {prods.data.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b></td>
                    <td>{p.category_name} <small>({p.category_code})</small></td>
                    <td>{p.commodity}{p.variety ? ` / ${p.variety}` : ''}</td>
                    <td>{p.unit}</td>
                    <td>{p.origin ?? '-'}</td>
                    <td>{p.production_method ?? '-'}{p.certification ? ` · ${p.certification}` : ''}</td>
                    <td><Badge tone={statusTone(p.status)}>{PRODUCT_STATUS_LABEL[p.status] ?? p.status}</Badge></td>
                    <td className="num">{p.batch_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3 style={{ marginTop: 16 }}>Tambah produk</h3>
        {cats.data && <ProductForm categories={cats.data} onCreated={prods.reload} />}
      </Card>

      <Card title="Batch / barang terdaftar">
        <div className="tabs">
          <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>Daftar batch</button>
          <button className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>Daftarkan barang</button>
        </div>
        {tab === 'list' && (
          batches.loading ? <p>Memuat…</p> : !batches.data?.length ? <Empty>Belum ada batch. Klik "Daftarkan barang".</Empty> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Kode batch</th><th>Produk</th><th>Jenis</th><th>Status</th><th>Grade</th><th className="num">Qty / tersedia</th><th className="num">Harga</th><th className="num">Foto</th><th>Tahap panen</th></tr>
                </thead>
                <tbody>
                  {batches.data.map((b) => (
                    <tr key={b.id}>
                      <td><Link to={`/supplier/batches/${b.id}`}><b>{b.batch_code}</b></Link><br /><small>{d(b.created_at)}</small></td>
                      <td>{b.product_name}<br /><small>{b.commodity} · {b.category_code}</small></td>
                      <td>{BATCH_TYPE_LABEL[b.type] ?? b.type}</td>
                      <td><Badge tone={statusTone(b.status)}>{BATCH_STATUS_LABEL[b.status] ?? b.status}</Badge></td>
                      <td>{b.grade ?? '-'}</td>
                      <td className="num">{num(b.quantity, 2)} / {num(b.available_quantity, 2)} {b.unit}</td>
                      <td className="num">{rupiah(b.price_per_unit)}/{b.unit}</td>
                      <td className="num">{b.photo_count}</td>
                      <td>{b.type === 'HARVEST' ? <>{HARVEST_STAGE_LABEL[b.harvest_stage] ?? b.harvest_stage ?? '-'}<br /><small>panen {d(b.expected_harvest_date)}</small></> : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {tab === 'new' && (prods.loading ? <p>Memuat…</p> : <BatchForm products={prods.data ?? []} />)}
      </Card>
    </>
  );
}
