import { useEffect, useState } from 'react';
import { api, errMsg, num } from '../../lib/api';
import { Card, Badge, Alert, Field, AsyncButton, Empty, useAsync } from '../../components/ui';
import { PageHead, Tabs, useTabs } from './shared';

const ATTR_TYPES = ['select', 'text', 'number', 'date'];
const TAX_CLASSES = ['STANDARD', 'BASIC_NEEDS_EXEMPT'];
const NEW_CATEGORY = { attribute_schema: [], active: true, tax_class: 'STANDARD' };

type Attr = { key: string; label: string; type: string; required: boolean; options?: string[]; unit?: string };

function SchemaEditor({ value, onChange }: { value: Attr[]; onChange: (v: Attr[]) => void }) {
  const upd = (i: number, patch: Partial<Attr>) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Key</th><th>Label</th><th>Tipe</th><th>Wajib</th><th>Opsi (pisahkan koma)</th><th>Satuan</th><th></th></tr></thead>
        <tbody>
          {value.map((a, i) => (
            <tr key={i}>
              <td><input value={a.key} onChange={(e) => upd(i, { key: e.target.value.replace(/\s+/g, '_').toLowerCase() })} placeholder="mis. size" /></td>
              <td><input value={a.label} onChange={(e) => upd(i, { label: e.target.value })} /></td>
              <td><select value={a.type} onChange={(e) => upd(i, { type: e.target.value })}>{ATTR_TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
              <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!a.required} onChange={(e) => upd(i, { required: e.target.checked })} /></td>
              <td><input value={(a.options ?? []).join(', ')} disabled={a.type !== 'select'} onChange={(e) => upd(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder={a.type === 'select' ? 'A, B, C' : '—'} /></td>
              <td><input value={a.unit ?? ''} onChange={(e) => upd(i, { unit: e.target.value || undefined })} style={{ width: 80 }} /></td>
              <td>
                <div className="row">
                  <button type="button" className="btn small secondary" disabled={i === 0} onClick={() => { const v = [...value]; [v[i - 1], v[i]] = [v[i], v[i - 1]]; onChange(v); }}>↑</button>
                  <button type="button" className="btn small danger" onClick={() => onChange(value.filter((_, j) => j !== i))}>Hapus</button>
                </div>
              </td>
            </tr>
          ))}
          {!value.length && <tr><td colSpan={7}><Empty>Belum ada atribut. Tambahkan minimal satu agar deklarasi kualitas terstruktur.</Empty></td></tr>}
        </tbody>
      </table>
      <button type="button" className="btn small secondary" style={{ marginTop: 8 }} onClick={() => onChange([...value, { key: '', label: '', type: 'text', required: true }])}>+ Tambah atribut</button>
    </div>
  );
}

function CategoryCard({ c, onSaved, isNew, onCancel }: { c: any; onSaved: () => Promise<void>; isNew?: boolean; onCancel?: () => void }) {
  const [f, setF] = useState({ code: c.code ?? '', name: c.name ?? '', tax_class: c.tax_class ?? 'STANDARD', min_photos: c.min_photos ?? '', packaging_rate_per_unit: c.packaging_rate_per_unit ?? '', active: c.active ?? true });
  const [schema, setSchema] = useState<Attr[]>(Array.isArray(c.attribute_schema) ? c.attribute_schema : []);
  const [open, setOpen] = useState(!!isNew);
  useEffect(() => { setF({ code: c.code ?? '', name: c.name ?? '', tax_class: c.tax_class ?? 'STANDARD', min_photos: c.min_photos ?? '', packaging_rate_per_unit: c.packaging_rate_per_unit ?? '', active: c.active ?? true }); setSchema(Array.isArray(c.attribute_schema) ? c.attribute_schema : []); }, [c]);

  const save = async () => {
    const code = String(f.code).trim().toUpperCase();
    if (!code) throw new Error('Kode kategori wajib diisi.');
    const bad = schema.find((a) => !a.key || !a.label);
    if (bad) throw new Error('Setiap atribut wajib memiliki key dan label.');
    const keys = schema.map((a) => a.key);
    if (new Set(keys).size !== keys.length) throw new Error('Key atribut harus unik.');
    const clean = schema.map((a) => ({ key: a.key, label: a.label, type: a.type, required: !!a.required, ...(a.type === 'select' ? { options: a.options ?? [] } : {}), ...(a.unit ? { unit: a.unit } : {}) }));
    await api.put(`/api/admin/categories/${code}`, {
      name: f.name, attribute_schema: clean, tax_class: f.tax_class, active: !!f.active,
      min_photos: f.min_photos === '' ? null : Number(f.min_photos), packaging_rate_per_unit: f.packaging_rate_per_unit === '' ? null : Number(f.packaging_rate_per_unit),
    });
    await onSaved();
    if (isNew && onCancel) onCancel(); else setOpen(false);
  };

  return (
    <Card
      title={isNew ? 'Kategori baru' : <>{c.code} — {c.name} <Badge tone={c.tax_class === 'STANDARD' ? 'warn' : 'good'}>{c.tax_class}</Badge> {!c.active && <Badge tone="bad">Nonaktif</Badge>}</>}
      actions={!isNew && <button type="button" className="btn small secondary" onClick={() => setOpen(!open)}>{open ? 'Tutup' : 'Ubah'}</button>}
    >
      {!open ? (
        <div className="row" style={{ gap: 18 }}>
          <span><small className="muted">Atribut</small><br />{(c.attribute_schema ?? []).length} field ({(c.attribute_schema ?? []).filter((a: any) => a.required).length} wajib)</span>
          <span><small className="muted">Min. foto</small><br />{c.min_photos ?? <span className="muted">default global</span>}</span>
          <span><small className="muted">Tarif packaging/unit</small><br />{c.packaging_rate_per_unit != null ? num(c.packaging_rate_per_unit) : <span className="muted">default per kg</span>}</span>
          <span><small className="muted">Field</small><br />{(c.attribute_schema ?? []).map((a: any) => <code key={a.key} style={{ marginRight: 4 }}>{a.key}</code>)}</span>
        </div>
      ) : (
        <>
          <form className="inline" onSubmit={(e) => e.preventDefault()}>
            <Field label="Kode" required hint="Huruf besar, unik; tidak bisa diubah setelah dibuat"><input value={f.code} disabled={!isNew} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required /></Field>
            <Field label="Nama" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></Field>
            <Field label="Tax class" hint="Dipakai tax engine untuk komponen PRODUCT (service_type)"><select value={f.tax_class} onChange={(e) => setF({ ...f, tax_class: e.target.value })}>{TAX_CLASSES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Min. foto deklarasi" hint="Kosong = ikut evidence.min_photos"><input type="number" min="0" step="1" value={f.min_photos} onChange={(e) => setF({ ...f, min_photos: e.target.value })} /></Field>
            <Field label="Tarif packaging per unit (Rp)" hint="Kosong = ikut packaging.rate_per_kg"><input type="number" min="0" step="1" value={f.packaging_rate_per_unit} onChange={(e) => setF({ ...f, packaging_rate_per_unit: e.target.value })} /></Field>
            <Field label="Aktif"><label className="row"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> tampil di katalog</label></Field>
          </form>
          <h3 style={{ marginTop: 12 }}>Skema atribut (deklarasi kualitas)</h3>
          <SchemaEditor value={schema} onChange={setSchema} />
          <div className="row" style={{ marginTop: 10 }}>
            <AsyncButton onClick={save}>Simpan kategori</AsyncButton>
            <button type="button" className="btn secondary" onClick={() => (isNew && onCancel ? onCancel() : setOpen(false))}>Batal</button>
          </div>
        </>
      )}
    </Card>
  );
}

function ReasonCodeRow({ r, onSaved }: { r: any; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ label: r.label, requires_video: !!r.requires_video, active: !!r.active, sort_order: String(r.sort_order ?? 100) });
  useEffect(() => setF({ label: r.label, requires_video: !!r.requires_video, active: !!r.active, sort_order: String(r.sort_order ?? 100) }), [r]);
  const dirty = f.label !== r.label || f.requires_video !== !!r.requires_video || f.active !== !!r.active || Number(f.sort_order) !== Number(r.sort_order);
  return (
    <tr style={{ opacity: r.active ? 1 : 0.6 }}>
      <td><code>{r.code}</code></td>
      <td><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></td>
      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={f.requires_video} onChange={(e) => setF({ ...f, requires_video: e.target.checked })} /></td>
      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /></td>
      <td><input type="number" step="1" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} style={{ width: 80 }} /></td>
      <td><AsyncButton className="btn small" disabled={!dirty} onClick={async () => { await api.put(`/api/admin/reason-codes/${r.code}`, { label: f.label, requires_video: f.requires_video, active: f.active, sort_order: Number(f.sort_order) }); await onSaved(); }}>Simpan</AsyncButton></td>
    </tr>
  );
}

export default function Catalog() {
  const { tab, setTab } = useTabs('categories');
  const cats = useAsync(() => api.get('/api/admin/categories'));
  const codes = useAsync(() => api.get('/api/admin/reason-codes'));
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState({ code: '', label: '', requires_video: true, sort_order: '200' });
  const [err, setErr] = useState('');

  return (
    <>
      <PageHead title="Kategori & Reason Code" desc="Skema atribut dinamis per kategori (dipakai form deklarasi kualitas supplier) dan kode alasan retur." />
      <Tabs tabs={[{ key: 'categories', label: 'Kategori' }, { key: 'codes', label: 'Reason code retur' }]} value={tab} onChange={setTab} />
      {err && <Alert kind="error">{err}</Alert>}

      {tab === 'categories' && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <button type="button" className="btn" onClick={() => setAdding(true)} disabled={adding}>+ Kategori baru</button>
            <small className="muted">Kategori nonaktif tetap tampil di sini dan dapat diaktifkan kembali; katalog publik hanya menampilkan kategori aktif.</small>
          </div>
          {adding && <CategoryCard c={NEW_CATEGORY} isNew onSaved={cats.reload} onCancel={() => setAdding(false)} />}
          {cats.loading && <p>Memuat…</p>}
          {cats.error && <Alert kind="error">{cats.error}</Alert>}
          {(cats.data ?? []).map((c: any) => <CategoryCard key={c.code} c={c} onSaved={cats.reload} />)}
          {cats.data && !cats.data.length && <Empty />}
        </>
      )}

      {tab === 'codes' && (
        <Card title="Reason code retur">
          {codes.loading && <p>Memuat…</p>}
          {codes.error && <Alert kind="error">{codes.error}</Alert>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Kode</th><th>Label</th><th style={{ textAlign: 'center' }}>Wajib video</th><th style={{ textAlign: 'center' }}>Aktif</th><th>Urutan</th><th></th></tr></thead>
              <tbody>
                {(codes.data ?? []).map((r: any) => <ReasonCodeRow key={r.code} r={r} onSaved={codes.reload} />)}
                <tr style={{ background: '#fafbfa' }}>
                  <td><input value={newCode.code} onChange={(e) => setNewCode({ ...newCode, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} placeholder="KODE_BARU" /></td>
                  <td><input value={newCode.label} onChange={(e) => setNewCode({ ...newCode, label: e.target.value })} placeholder="Label" /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={newCode.requires_video} onChange={(e) => setNewCode({ ...newCode, requires_video: e.target.checked })} /></td>
                  <td style={{ textAlign: 'center' }}><Badge tone="good">Aktif</Badge></td>
                  <td><input type="number" value={newCode.sort_order} onChange={(e) => setNewCode({ ...newCode, sort_order: e.target.value })} style={{ width: 80 }} /></td>
                  <td>
                    <AsyncButton className="btn small" disabled={!newCode.code || newCode.label.length < 2} onClick={async () => {
                      setErr('');
                      try {
                        await api.put(`/api/admin/reason-codes/${newCode.code}`, { label: newCode.label, requires_video: newCode.requires_video, active: true, sort_order: Number(newCode.sort_order) });
                        setNewCode({ code: '', label: '', requires_video: true, sort_order: '200' });
                        await codes.reload();
                      } catch (e) { setErr(errMsg(e)); }
                    }}>Tambah</AsyncButton>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>Buyer hanya melihat kode aktif saat mengajukan klaim; kode dengan "wajib video" memaksa unggahan video penerimaan.</p>
        </Card>
      )}
    </>
  );
}
