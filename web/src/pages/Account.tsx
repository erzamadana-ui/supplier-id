import { useState } from 'react';
import { api, errMsg, setToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, Alert, Field, Badge } from '../components/ui';

/** Akun saya: profil ringkas + ganti kata sandi (mencabut semua sesi lama). */
export default function AccountPage() {
  const { user, organization } = useAuth();
  const [f, setF] = useState({ current: '', next: '', next2: '' });
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(''); setErr('');
    if (f.next.length < 8) return setErr('Kata sandi baru minimal 8 karakter.');
    if (f.next !== f.next2) return setErr('Konfirmasi kata sandi tidak sama.');
    setBusy(true);
    try {
      const r = await api.post('/api/auth/change-password', { current_password: f.current, new_password: f.next });
      if (r.token) setToken(r.token); // sesi ini tetap masuk; sesi/perangkat lain otomatis keluar
      setF({ current: '', next: '', next2: '' });
      setMsg('Kata sandi diperbarui. Sesi di perangkat lain telah dikeluarkan.');
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head"><h1>Akun saya</h1></div>
      <div className="grid cols-2">
        <Card title="Profil">
          <p><b>{user?.name}</b><br /><span className="muted">{user?.email}</span></p>
          <p><Badge>{user?.role}</Badge></p>
          {organization && (
            <p>
              <b>{organization.name}</b><br />
              <small className="muted">
                {organization.supplier_kind ? organization.supplier_kind + ' · ' : ''}{organization.tax_status}{organization.region ? ' · ' + organization.region : ''}
                {organization.verified ? ' · Terverifikasi' : ' · Belum diverifikasi admin'}
              </small>
            </p>
          )}
          <p className="muted"><small>Perubahan nama usaha, status pajak, dan rekening bank dilakukan oleh admin Supplier.id (hubungi dukungan) agar data pajak & payout tetap konsisten.</small></p>
        </Card>
        <Card title="Ganti kata sandi">
          {msg && <Alert kind="success">{msg}</Alert>}
          {err && <Alert kind="error">{err}</Alert>}
          <form onSubmit={submit}>
            <Field label="Kata sandi saat ini" required><input type="password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" /></Field>
            <Field label="Kata sandi baru" required hint="Minimal 8 karakter"><input type="password" required minLength={8} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" /></Field>
            <Field label="Ulangi kata sandi baru" required><input type="password" required value={f.next2} onChange={(e) => setF({ ...f, next2: e.target.value })} autoComplete="new-password" /></Field>
            <button className="btn" type="submit" disabled={busy}>{busy ? '…' : 'Simpan kata sandi'}</button>
          </form>
        </Card>
      </div>
    </>
  );
}
