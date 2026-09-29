import { useState } from 'react';
import { api, pct, dt, errMsg } from '../../lib/api';
import { Card, Stat, Badge, Alert, Field, AsyncButton, Empty, useAsync } from '../../components/ui';
import { PageHead, DiffCell, FEE_SCOPES, FEE_STATUS_LABEL, SCOPE_LABEL, localToIso } from './shared';

const feeTone = (s: string) => (s === 'ACTIVE' ? 'good' : s === 'PENDING_APPROVAL' ? 'warn' : s === 'REJECTED' ? 'bad' : '');
const PRESETS = [10, 12, 15, 18];

export default function Fees() {
  const fees = useAsync(() => api.get('/api/admin/fees'));
  const cats = useAsync(() => api.get('/api/categories'));
  const suppliers = useAsync(() => api.get('/api/admin/organizations?type=SUPPLIER'));
  const buyers = useAsync(() => api.get('/api/admin/organizations?type=BUYER'));
  const audits = useAsync(() => api.get('/api/admin/audit-logs?limit=300'));

  const [rate, setRate] = useState('15');
  const [scopeType, setScopeType] = useState('GLOBAL');
  const [scopeRef, setScopeRef] = useState('');
  const [effFrom, setEffFrom] = useState('');
  const [effTo, setEffTo] = useState('');
  const [reason, setReason] = useState('');
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const current = fees.data?.current;
  const history: any[] = fees.data?.history ?? [];
  const requiresApproval = !!fees.data?.requires_approval;
  const feeAudits: any[] = (audits.data ?? []).filter((a: any) => a.entity === 'fee_configs');

  const reloadAll = async () => { await fees.reload(); await audits.reload(); };

  const submit = async () => {
    setErr(''); setMsg('');
    if (!reason.trim() || reason.trim().length < 3) { setErr('Alasan wajib diisi (min. 3 karakter).'); return; }
    if (scopeType !== 'GLOBAL' && !scopeRef.trim()) { setErr('Scope ref wajib diisi untuk scope selain GLOBAL.'); return; }
    try {
      const body: any = { rate_percent: Number(rate), scope_type: scopeType, reason: reason.trim() };
      if (scopeType !== 'GLOBAL') body.scope_ref = scopeRef.trim();
      if (effFrom) body.effective_from = localToIso(effFrom);
      if (effTo) body.effective_to = localToIso(effTo);
      const r = await api.post('/api/admin/fees', body);
      setMsg(r.status === 'PENDING_APPROVAL' ? `Perubahan fee ${pct(r.rate_percent)} tersimpan dan MENUNGGU PERSETUJUAN admin lain.` : `Platform fee ${pct(r.rate_percent)} aktif sejak ${dt(r.effective_from)}.`);
      setReason(''); setEffFrom(''); setEffTo('');
      await reloadAll();
    } catch (e) { setErr(errMsg(e)); }
  };

  const scopeOptions = () => {
    // resolvePlatformFee mencocokkan scope_ref CATEGORY dengan category.id (UUID), bukan code
    if (scopeType === 'CATEGORY') return (cats.data ?? []).map((c: any) => ({ v: c.id, l: `${c.code} — ${c.name}` }));
    if (scopeType === 'SUPPLIER') return (suppliers.data ?? []).map((o: any) => ({ v: o.id, l: o.name }));
    if (scopeType === 'BUYER') return (buyers.data ?? []).map((o: any) => ({ v: o.id, l: o.name }));
    return null;
  };
  const opts = scopeOptions();
  const refName = (row: any) => {
    if (!row.scope_ref) return '';
    if (row.scope_type === 'SUPPLIER') return (suppliers.data ?? []).find((o: any) => o.id === row.scope_ref)?.name ?? row.scope_ref;
    if (row.scope_type === 'BUYER') return (buyers.data ?? []).find((o: any) => o.id === row.scope_ref)?.name ?? row.scope_ref;
    if (row.scope_type === 'CATEGORY') { const c = (cats.data ?? []).find((x: any) => x.id === row.scope_ref); return c ? `${c.code} — ${c.name}` : row.scope_ref; }
    return row.scope_ref;
  };

  return (
    <>
      <PageHead title="Finance → Fees & Monetization → Platform Fee" desc="Platform fee adalah parameter sistem yang bisa diubah kapan saja dengan jejak audit; bukan hard-code." />

      {fees.error && <Alert kind="error">{fees.error}</Alert>}
      {fees.loading && <p>Memuat…</p>}

      {fees.data && (
        <>
          <div className="stats">
            <Stat label="Platform fee default saat ini" value={current ? pct(current.rate_percent) : '-'} tone="good" hint={current ? `${SCOPE_LABEL[current.scope_type] ?? current.scope_type}${current.scope_ref ? ' · ' + current.scope_ref : ''} · berlaku sejak ${dt(current.effective_from)}` : 'Belum ada fee aktif'} />
            <Stat label="Dual control" value={requiresApproval ? 'Aktif' : 'Nonaktif'} tone={requiresApproval ? 'warn' : 'muted'} hint={requiresApproval ? 'Perubahan fee butuh persetujuan admin lain' : 'Perubahan fee langsung aktif'} />
            <Stat label="Riwayat konfigurasi" value={history.length} hint={`${history.filter((h) => h.status === 'PENDING_APPROVAL').length} menunggu persetujuan`} />
          </div>

          <Alert kind="info">
            <b>Parameter sistem — bukan hard-code; default 15%.</b> Fee yang berlaku dipilih berdasarkan scope paling spesifik yang cocok dan tanggal efektif. Order yang sudah dikonfirmasi tetap memakai rate lama karena pricing di-snapshot saat konfirmasi (<code>pricing_snapshot.feeConfig</code>); perubahan hanya berlaku untuk order baru.
          </Alert>

          <div className="grid cols-2">
            <Card title="Ubah platform fee">
              {msg && <Alert kind="success">{msg}</Alert>}
              {err && <Alert kind="error">{err}</Alert>}
              <form className="inline" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <Field label="Rate (%)" required>
                  <input type="number" step="0.01" min="0" max="100" value={rate} onChange={(e) => setRate(e.target.value)} required />
                </Field>
                <Field label="Preset">
                  <div className="row">{PRESETS.map((p) => <button key={p} type="button" className={`btn small ${Number(rate) === p ? '' : 'secondary'}`} onClick={() => setRate(String(p))}>{p}%</button>)}</div>
                </Field>
                <Field label="Scope" required>
                  <select value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeRef(''); }}>
                    {FEE_SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s] ?? s}</option>)}
                  </select>
                </Field>
                {scopeType !== 'GLOBAL' && (
                  <Field label="Scope ref" required hint={scopeType === 'VALUE_TIER' ? 'Format min-max, mis. 0-50000000' : scopeType === 'REGION' ? 'Nama wilayah persis seperti di profil organisasi' : scopeType === 'PROMOTION' ? 'Kode promo' : scopeType === 'CONTRACT' ? 'Nomor/ID kontrak' : undefined}>
                    {opts ? (
                      <select value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} required>
                        <option value="">— pilih —</option>
                        {opts.map((o: any) => <option key={o.v} value={o.v}>{o.l}</option>)}
                      </select>
                    ) : (
                      <input value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} placeholder={scopeType === 'VALUE_TIER' ? '0-50000000' : ''} required />
                    )}
                  </Field>
                )}
                <Field label="Berlaku sejak" hint="Kosong = berlaku sekarang">
                  <input type="datetime-local" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
                </Field>
                <Field label="Berlaku sampai" hint="Opsional">
                  <input type="datetime-local" value={effTo} onChange={(e) => setEffTo(e.target.value)} />
                </Field>
                <Field label="Alasan perubahan" required>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. penyesuaian strategi take rate Q4" required />
                </Field>
                <div className="form-actions">
                  <button className="btn" type="submit">{requiresApproval ? 'Ajukan perubahan (butuh persetujuan)' : 'Simpan & aktifkan'}</button>
                </div>
              </form>
            </Card>

            <Card title="Dual control (persetujuan perubahan fee)">
              <p>Jika aktif, setiap perubahan fee berstatus <Badge tone="warn">Menunggu persetujuan</Badge> dan baru aktif setelah disetujui oleh admin yang berbeda dari pembuatnya.</p>
              <label className="row" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={requiresApproval} onChange={async (e) => {
                  const v = e.target.checked;
                  try { await api.put('/api/admin/settings/fee.change_requires_approval', { value: v, reason: v ? 'Aktifkan dual control fee' : 'Nonaktifkan dual control fee' }); await reloadAll(); } catch (er) { setErr(errMsg(er)); }
                }} />
                <span>Perubahan fee butuh persetujuan (dual control)</span>
              </label>
              <p className="muted" style={{ marginTop: 10 }}>Tersimpan sebagai setting <code>fee.change_requires_approval</code>.</p>
            </Card>
          </div>

          <Card title="Riwayat platform fee">
            {!history.length ? <Empty /> : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Berlaku sejak</th><th>Sampai</th><th>Scope</th><th className="num">Sebelum → Rate</th><th>Status</th><th>Alasan</th><th>Dibuat oleh</th><th>Disetujui oleh</th><th>Aksi</th></tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>{dt(h.effective_from)}</td>
                        <td>{h.effective_to ? dt(h.effective_to) : <span className="muted">—</span>}</td>
                        <td>{SCOPE_LABEL[h.scope_type] ?? h.scope_type}{h.scope_ref && <><br /><small>{refName(h)}</small></>}</td>
                        <td className="num">{h.previous_value != null ? `${pct(h.previous_value)} → ` : ''}<b>{pct(h.rate_percent)}</b></td>
                        <td><Badge tone={feeTone(h.status)}>{FEE_STATUS_LABEL[h.status] ?? h.status}</Badge></td>
                        <td>{h.reason}</td>
                        <td>{h.created_by_name ?? <span className="muted">sistem</span>}<br /><small>{dt(h.created_at)}</small></td>
                        <td>{h.approved_by_name ?? '-'}{h.approved_at && <><br /><small>{dt(h.approved_at)}</small></>}</td>
                        <td>
                          {h.status === 'PENDING_APPROVAL' && (
                            <div style={{ display: 'grid', gap: 6, minWidth: 180 }}>
                              <small className="muted">Penyetuju harus admin berbeda dari pembuat.</small>
                              <AsyncButton className="btn small" confirm={`Setujui fee ${pct(h.rate_percent)}?`} onClick={async () => { await api.post(`/api/admin/fees/${h.id}/approve`); await reloadAll(); }}>Setujui</AsyncButton>
                              <input placeholder="Alasan penolakan" value={rejectReason[h.id] ?? ''} onChange={(e) => setRejectReason({ ...rejectReason, [h.id]: e.target.value })} />
                              <AsyncButton className="btn small danger" disabled={(rejectReason[h.id] ?? '').trim().length < 3} onClick={async () => { await api.post(`/api/admin/fees/${h.id}/reject`, { reason: rejectReason[h.id] }); await reloadAll(); }}>Tolak</AsyncButton>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Audit log perubahan fee">
            {audits.error && <Alert kind="error">{audits.error}</Alert>}
            {!feeAudits.length ? <Empty>Belum ada audit log untuk fee_configs.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Waktu</th><th>Pengguna</th><th>Aksi</th><th>Alasan</th><th>Perubahan (before → after)</th></tr></thead>
                  <tbody>
                    {feeAudits.map((a) => (
                      <tr key={a.id}>
                        <td>{dt(a.created_at)}</td>
                        <td>{a.user_name ?? '-'}</td>
                        <td><Badge>{a.action}</Badge></td>
                        <td>{a.reason ?? '-'}</td>
                        <td><DiffCell before={a.before} after={a.after} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <p className="footer-note">Fee dengan scope lebih spesifik (kategori/supplier/buyer/kontrak/promosi/tier/wilayah) mengalahkan fee GLOBAL bila tanggal efektifnya berlaku. Rate yang sudah terkunci di order tidak pernah diubah retroaktif.</p>
    </>
  );
}
