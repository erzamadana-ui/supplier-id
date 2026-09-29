import { useState } from 'react';
import { api, pct, num, dt, errMsg } from '../../lib/api';
import { Card, Badge, Alert, Field, AsyncButton, Empty, useAsync } from '../../components/ui';
import { PageHead, TAX_COMPONENTS, COMPONENT_LABEL } from './shared';

const STATUSES = ['ANY', 'PKP', 'NON_PKP'];

function RuleRow({ r, onSaved }: { r: any; onSaved: () => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ taxable: !!r.taxable, rate_percent: String(r.rate_percent ?? 0), dpp_factor: String(r.dpp_factor ?? 1), priority: String(r.priority ?? 100), active: !!r.active });
  const save = async () => {
    const reason = window.prompt('Alasan perubahan aturan pajak (untuk audit log):', '');
    if (reason === null) return;
    await api.patch(`/api/admin/tax-rules/${r.id}`, { taxable: f.taxable, rate_percent: Number(f.rate_percent), dpp_factor: Number(f.dpp_factor), priority: Number(f.priority), active: f.active, reason: reason || undefined });
    setEdit(false);
    await onSaved();
  };
  return (
    <tr style={{ opacity: r.active ? 1 : 0.55 }}>
      <td>{r.name}<br /><small className="muted">sejak {dt(r.effective_from)}{r.effective_to ? ` s/d ${dt(r.effective_to)}` : ''}</small></td>
      <td>{r.transaction_type}</td>
      <td>{r.seller_status}</td>
      <td>{r.buyer_status}</td>
      <td>{r.service_type}</td>
      <td>{edit ? <input type="checkbox" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} /> : <Badge tone={r.taxable ? 'warn' : 'good'}>{r.taxable ? 'Kena pajak' : 'Tidak'}</Badge>}</td>
      <td className="num">{edit ? <input type="number" step="0.01" min="0" max="100" value={f.rate_percent} onChange={(e) => setF({ ...f, rate_percent: e.target.value })} style={{ width: 90 }} /> : pct(r.rate_percent)}</td>
      <td className="num">{edit ? <input type="number" step="0.0001" min="0.0001" value={f.dpp_factor} onChange={(e) => setF({ ...f, dpp_factor: e.target.value })} style={{ width: 90 }} /> : num(r.dpp_factor, 4)}</td>
      <td className="num">{edit ? <input type="number" step="1" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} style={{ width: 70 }} /> : r.priority}</td>
      <td>{edit ? <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> : <Badge tone={r.active ? 'good' : 'bad'}>{r.active ? 'Aktif' : 'Nonaktif'}</Badge>}</td>
      <td>
        {edit ? (
          <div className="row">
            <AsyncButton className="btn small" onClick={save}>Simpan</AsyncButton>
            <button className="btn small secondary" type="button" onClick={() => setEdit(false)}>Batal</button>
          </div>
        ) : <button className="btn small secondary" type="button" onClick={() => { setF({ taxable: !!r.taxable, rate_percent: String(r.rate_percent ?? 0), dpp_factor: String(r.dpp_factor ?? 1), priority: String(r.priority ?? 100), active: !!r.active }); setEdit(true); }}>Ubah</button>}
      </td>
    </tr>
  );
}

export default function Tax() {
  const rules = useAsync(() => api.get('/api/admin/tax-rules'));
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState({ name: '', component: 'PRODUCT', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'ANY', taxable: true, rate_percent: '11', dpp_factor: '1', priority: '100', effective_from: '', reason: '' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const list: any[] = rules.data ?? [];
  const byComponent = TAX_COMPONENTS.map((c) => ({ c, rows: list.filter((r) => r.component === c).sort((a, b) => a.priority - b.priority) }));

  const add = async () => {
    setErr(''); setMsg('');
    try {
      const body: any = { ...f, taxable: !!f.taxable, rate_percent: Number(f.rate_percent), dpp_factor: Number(f.dpp_factor), priority: Number(f.priority) };
      if (!f.effective_from) delete body.effective_from; else body.effective_from = new Date(f.effective_from).toISOString();
      if (!f.reason) delete body.reason;
      const r = await api.post('/api/admin/tax-rules', body);
      setMsg(`Aturan "${r.name}" ditambahkan.`);
      setShowForm(false);
      setF({ ...f, name: '', reason: '' });
      await rules.reload();
    } catch (e) { setErr(errMsg(e)); }
  };

  return (
    <>
      <PageHead title="Tax Engine" desc="Aturan PPN per komponen harga. Dapat dikonfigurasi Finance tanpa perubahan kode." actions={<button className="btn" type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Tutup form' : '+ Tambah aturan'}</button>} />

      <Alert kind="warn">
        <b>Nilai default adalah ASUMSI — wajib divalidasi Finance/konsultan pajak.</b> Aturan dipilih per komponen berdasarkan seller/buyer status (PKP/NON_PKP), service_type (tax_class kategori untuk komponen PRODUCT), prioritas terkecil menang. Pajak = base × dpp_factor × rate. Aturan nonaktif atau di luar tanggal efektif diabaikan.
      </Alert>

      {msg && <Alert kind="success">{msg}</Alert>}
      {err && <Alert kind="error">{err}</Alert>}

      {showForm && (
        <Card title="Tambah aturan pajak">
          <form className="inline" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <Field label="Nama aturan" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={3} /></Field>
            <Field label="Komponen" required>
              <select value={f.component} onChange={(e) => setF({ ...f, component: e.target.value })}>{TAX_COMPONENTS.map((c) => <option key={c} value={c}>{COMPONENT_LABEL[c]} ({c})</option>)}</select>
            </Field>
            <Field label="Transaction type" hint="ANY atau jenis transaksi khusus"><input value={f.transaction_type} onChange={(e) => setF({ ...f, transaction_type: e.target.value })} /></Field>
            <Field label="Status seller"><select value={f.seller_status} onChange={(e) => setF({ ...f, seller_status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Status buyer"><select value={f.buyer_status} onChange={(e) => setF({ ...f, buyer_status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Service type / tax_class" hint="ANY, STANDARD, BASIC_NEEDS_EXEMPT, …"><input value={f.service_type} onChange={(e) => setF({ ...f, service_type: e.target.value })} /></Field>
            <Field label="Kena pajak"><label className="row"><input type="checkbox" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} /> taxable</label></Field>
            <Field label="Rate (%)"><input type="number" step="0.01" min="0" max="100" value={f.rate_percent} onChange={(e) => setF({ ...f, rate_percent: e.target.value })} /></Field>
            <Field label="DPP factor" hint="mis. 1 = 100% dasar, 0.6667 = DPP nilai lain"><input type="number" step="0.0001" min="0.0001" value={f.dpp_factor} onChange={(e) => setF({ ...f, dpp_factor: e.target.value })} /></Field>
            <Field label="Prioritas" hint="Angka terkecil menang"><input type="number" step="1" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field>
            <Field label="Berlaku sejak" hint="Kosong = sekarang"><input type="datetime-local" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
            <Field label="Alasan"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <div className="form-actions"><button className="btn" type="submit">Simpan aturan</button></div>
          </form>
        </Card>
      )}

      {rules.loading && <p>Memuat…</p>}
      {rules.error && <Alert kind="error">{rules.error}</Alert>}
      {rules.data && byComponent.map(({ c, rows }) => (
        <Card key={c} title={<>{COMPONENT_LABEL[c]} <small className="muted">({c}) · {rows.length} aturan</small></>}>
          {!rows.length ? <Empty>Belum ada aturan untuk komponen ini — komponen dianggap tidak kena pajak.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Nama</th><th>Transaksi</th><th>Seller</th><th>Buyer</th><th>Service type</th><th>Kena pajak</th><th className="num">Rate</th><th className="num">DPP factor</th><th className="num">Prioritas</th><th>Aktif</th><th></th></tr>
                </thead>
                <tbody>{rows.map((r) => <RuleRow key={r.id} r={r} onSaved={rules.reload} />)}</tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
      <p className="footer-note">Keterbatasan: perubahan aturan hanya memengaruhi order baru (pajak per order tersimpan di pricing_snapshot.taxLines). Tarif/kelas pajak di sini adalah parameter konfigurasi, bukan opini pajak.</p>
    </>
  );
}
