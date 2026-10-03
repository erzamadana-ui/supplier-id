import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { errMsg, DEMO_MODE } from '../lib/api';
import { Card, Alert } from '../components/ui';

const DEMO = [
  { email: 'admin@supplier.id', label: 'Admin Supplier.id' },
  { email: 'finance@supplier.id', label: 'Admin — Finance Approver (dual control fee)' },
  { email: 'tani@supplier.id', label: 'Supplier — Kelompok Tani Sumber Rezeki (non-PKP)' },
  { email: 'ternak@supplier.id', label: 'Supplier — PT Ternak Nusantara (PKP)' },
  { email: 'nelayan@supplier.id', label: 'Supplier — Koperasi Nelayan Batam' },
  { email: 'buyer@supplier.id', label: 'Buyer — PT Resto Sumatera Group' },
  { email: 'hotel@supplier.id', label: 'Buyer — Hotel Bukittinggi Indah' },
];

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate(); const [sp] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(DEMO_MODE ? 'Password123' : '');
  const [err, setErr] = useState('');
  const go = async (e?: string) => {
    setErr('');
    try { await login(e ?? email, password); nav(sp.get('next') ?? '/'); } catch (x) { setErr(errMsg(x)); }
  };
  return (
    <div className="login">
      <Card title={<span>Supplier<span style={{ color: 'var(--brand)' }}>-ID</span> — masuk</span>}>
        <p className="muted">Masuk sebagai pelanggan, mitra, kurir, atau admin. <Link to="/">← Beranda</Link></p>
        {err && <Alert kind="error">{err}</Alert>}
        <form onSubmit={(e) => { e.preventDefault(); go(); }}>
          <label className="field"><span className="field-label">Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@perusahaan.id" /></label>
          <label className="field"><span className="field-label">Kata sandi</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="btn" type="submit">Masuk</button>
          <span style={{ marginLeft: 12 }}><Link to="/register">Belum punya akun? Daftar</Link></span>
        </form>
        {DEMO_MODE && <div className="demo">
          <small>Akun demo (sandi: Password123):</small>
          {DEMO.map((d) => <button key={d.email} className="btn secondary small" onClick={() => { setEmail(d.email); go(d.email); }}>{d.label}</button>)}
        </div>}
      </Card>
    </div>
  );
}
