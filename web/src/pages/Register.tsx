import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errMsg, setToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, Alert, Field } from '../components/ui';

const SUPPLIER_KINDS: [string, string][] = [
  ['PETANI', 'Petani'], ['PETERNAK', 'Peternak'], ['NELAYAN', 'Nelayan'], ['KELOMPOK_TANI', 'Kelompok tani'], ['KOPERASI', 'Koperasi'], ['PRODUSEN', 'Produsen'], ['SUPPLIER', 'Supplier / pedagang'],
];

/** Pendaftaran akun Supplier atau Buyer (self-service). Admin hanya dibuat dari seed/ops. */
export default function RegisterPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [role, setRole] = useState<'SUPPLIER' | 'BUYER'>('SUPPLIER');
  const [f, setF] = useState({ name: '', email: '', password: '', password2: '', orgName: '', supplierKind: 'PETANI', taxStatus: 'NON_PKP', region: '', address: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.password.length < 8) return setErr('Kata sandi minimal 8 karakter.');
    if (f.password !== f.password2) return setErr('Konfirmasi kata sandi tidak sama.');
    setBusy(true);
    try {
      const r = await api.post('/api/auth/register', {
        email: f.email.trim(), password: f.password, name: f.name.trim(), role, orgName: f.orgName.trim(),
        supplierKind: role === 'SUPPLIER' ? f.supplierKind : undefined, taxStatus: f.taxStatus, region: f.region || undefined, address: f.address || undefined,
      });
      setToken(r.token); await refresh(); nav('/');
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <Card title={<span>Daftar ke Supplier<span style={{ color: 'var(--brand)' }}>.id</span></span>}>
        <p className="muted">Supplier mendeklarasikan kualitas dengan foto aktual & jaminan retur; buyer memesan dengan harga transparan dan inspeksi saat terima.</p>
        {err && <Alert kind="error">{err}</Alert>}
        <div className="tabs">
          <button type="button" className={role === 'SUPPLIER' ? 'active' : ''} onClick={() => setRole('SUPPLIER')}>Saya Supplier (petani/peternak/nelayan)</button>
          <button type="button" className={role === 'BUYER' ? 'active' : ''} onClick={() => setRole('BUYER')}>Saya Buyer (resto/hotel/industri)</button>
        </div>
        <form onSubmit={submit}>
          <div className="grid cols-2">
            <Field label="Nama lengkap" required><input required value={f.name} onChange={set('name')} /></Field>
            <Field label="Email" required><input type="email" required value={f.email} onChange={set('email')} placeholder="email@perusahaan.id" /></Field>
            <Field label="Kata sandi" required hint="Minimal 8 karakter"><input type="password" required minLength={8} value={f.password} onChange={set('password')} /></Field>
            <Field label="Ulangi kata sandi" required><input type="password" required value={f.password2} onChange={set('password2')} /></Field>
            <Field label={role === 'SUPPLIER' ? 'Nama usaha / kelompok' : 'Nama perusahaan'} required><input required value={f.orgName} onChange={set('orgName')} /></Field>
            {role === 'SUPPLIER' && (
              <Field label="Jenis supplier" required>
                <select value={f.supplierKind} onChange={set('supplierKind')}>{SUPPLIER_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              </Field>
            )}
            <Field label="Status pajak" hint="PKP: Pengusaha Kena Pajak (menentukan PPN komponen produk)">
              <select value={f.taxStatus} onChange={set('taxStatus')}><option value="NON_PKP">Non-PKP</option><option value="PKP">PKP</option></select>
            </Field>
            <Field label="Wilayah (kota/kabupaten, provinsi)"><input value={f.region} onChange={set('region')} placeholder="Pekanbaru, Riau" /></Field>
          </div>
          <Field label="Alamat"><textarea rows={2} value={f.address} onChange={set('address')} /></Field>
          <p className="muted"><small>Dengan mendaftar, supplier menyetujui deklarasi kualitas & jaminan retur yang akan diminta saat publikasi batch; buyer menyetujui kewajiban inspeksi saat barang tiba.</small></p>
          <button className="btn" type="submit" disabled={busy}>{busy ? '…' : 'Buat akun'}</button>
          <span style={{ marginLeft: 12 }}><Link to="/login">Sudah punya akun? Masuk</Link></span>
        </form>
      </Card>
    </div>
  );
}
