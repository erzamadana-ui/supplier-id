import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupiah, num, dt } from '../../lib/api';
import { Card, Stat, Badge, Alert, Empty, useAsync } from '../../components/ui';
import { PageHead, Tabs, useTabs, DiffCell, ACCOUNT_GROUPS, ACCOUNT_LABEL, ALL_ACCOUNTS } from './shared';

function Reconciliation() {
  const [orderId, setOrderId] = useState('');
  const [applied, setApplied] = useState('');
  const rec = useAsync(() => api.get(`/api/admin/reconcile${applied ? `?order_id=${encodeURIComponent(applied)}` : ''}`), [applied]);
  const r = rec.data;
  const bal: Record<string, { debit: number; credit: number; net: number }> = r?.balances ?? {};
  const unknown = Object.keys(bal).filter((a) => !ALL_ACCOUNTS.includes(a));
  return (
    <>
      <Card>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); setApplied(orderId.trim()); }}>
          <label className="field"><span className="field-label">Rekonsiliasi satu order (ID order, opsional)</span><input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="UUID order — kosong = seluruh ledger" /></label>
          <div className="form-actions">
            <button className="btn" type="submit">Terapkan</button>
            {applied && <button className="btn secondary" type="button" onClick={() => { setOrderId(''); setApplied(''); }}>Seluruh ledger</button>}
          </div>
        </form>
      </Card>
      {rec.loading && <p>Memuat…</p>}
      {rec.error && <Alert kind="error">{rec.error}</Alert>}
      {r && (
        <>
          <Alert kind={r.balanced ? 'success' : 'error'}>
            <b>{r.balanced ? 'Seimbang' : 'TIDAK seimbang'}</b> — formula: <code>{r.formula}</code>
            {!r.balanced && <> · variance {rupiah(r.variance)} · jurnal tidak seimbang: {r.unbalancedJournals?.length ?? 0}</>}
          </Alert>
          <div className="stats">
            <Stat label="Money in" value={rupiah(r.moneyIn)} hint="Debit kas (pembayaran buyer)" />
            <Stat label="Money out" value={rupiah(r.moneyOut)} hint="Kredit kas (refund, payout, biaya)" />
            <Stat label="Receivables" value={rupiah(r.receivables)} hint="Piutang klaim ke logistik" />
            <Stat label="Liabilities" value={rupiah(r.liabilities)} hint="Utang supplier + refund + logistik" />
            <Stat label="Tax" value={rupiah(r.tax)} hint="Utang PPN neto" />
            <Stat label="Revenue" value={rupiah(r.revenue)} tone="good" />
            <Stat label="Expenses" value={rupiah(r.expenses)} tone="warn" />
            <Stat label="Net revenue" value={rupiah(r.netRevenue)} tone={Number(r.netRevenue) >= 0 ? 'good' : 'bad'} />
            <Stat label="Variance" value={rupiah(r.variance)} tone={r.balanced ? 'good' : 'bad'} hint={<Badge tone={r.balanced ? 'good' : 'bad'}>{r.balanced ? 'balanced' : 'tidak seimbang'}</Badge>} />
          </div>

          {r.unbalancedJournals?.length > 0 && (
            <Card title="Jurnal tidak seimbang">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Journal ID</th><th>Tipe</th><th className="num">Debit</th><th className="num">Kredit</th><th className="num">Selisih</th></tr></thead>
                  <tbody>{r.unbalancedJournals.map((j: any) => <tr key={j.id}><td><code>{j.id}</code></td><td>{j.journal_type}</td><td className="num">{rupiah(j.debit)}</td><td className="num">{rupiah(j.credit)}</td><td className="num">{rupiah(Number(j.debit) - Number(j.credit))}</td></tr>)}</tbody>
                </table>
              </div>
            </Card>
          )}

          <Card title="Saldo per akun">
            {!Object.keys(bal).length ? <Empty>Belum ada entri ledger.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Akun</th><th className="num">Debit</th><th className="num">Kredit</th><th className="num">Saldo neto</th></tr></thead>
                  <tbody>
                    {Object.entries(ACCOUNT_GROUPS).map(([group, accounts]) => {
                      const present = accounts.filter((a) => bal[a]);
                      if (!present.length) return null;
                      const sum = present.reduce((s, a) => s + Number(bal[a].net), 0);
                      return [
                        <tr key={group + '-h'} style={{ background: '#fafbfa' }}><td colSpan={4}><b>{group}</b> <small className="muted">{group === 'Aset' || group === 'Beban' ? 'saldo normal debit' : 'saldo normal kredit'}</small></td></tr>,
                        ...present.map((a) => (
                          <tr key={a}><td style={{ paddingLeft: 20 }}>{ACCOUNT_LABEL[a] ?? a} <code>{a}</code></td><td className="num">{rupiah(bal[a].debit)}</td><td className="num">{rupiah(bal[a].credit)}</td><td className="num">{rupiah(bal[a].net)}</td></tr>
                        )),
                        <tr key={group + '-t'} className="total"><td>Total {group}</td><td></td><td></td><td className="num">{rupiah(sum)}</td></tr>,
                      ];
                    })}
                    {unknown.map((a) => <tr key={a}><td>{a} <Badge tone="warn">tidak terklasifikasi</Badge></td><td className="num">{rupiah(bal[a].debit)}</td><td className="num">{rupiah(bal[a].credit)}</td><td className="num">{rupiah(bal[a].net)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Journal() {
  const [account, setAccount] = useState('');
  const [orderId, setOrderId] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState('500');
  const [applied, setApplied] = useState({ account: '', orderId: '', limit: '500' });
  const qs = new URLSearchParams();
  if (applied.orderId) qs.set('order_id', applied.orderId);
  if (applied.account) qs.set('account', applied.account);
  qs.set('limit', applied.limit || '500');
  const led = useAsync(() => api.get(`/api/admin/ledger?${qs.toString()}`), [applied.orderId, applied.account, applied.limit]);
  const rows: any[] = (led.data ?? []).filter((e: any) => !search || `${e.order_no ?? ''} ${e.reference ?? ''} ${e.memo ?? ''} ${e.journal_type}`.toLowerCase().includes(search.toLowerCase()));
  const totals = rows.reduce((a, e) => ({ d: a.d + (e.side === 'DEBIT' ? Number(e.amount) : 0), c: a.c + (e.side === 'CREDIT' ? Number(e.amount) : 0) }), { d: 0, c: 0 });
  return (
    <>
      <Card>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); setApplied({ account, orderId: orderId.trim(), limit }); }}>
          <label className="field"><span className="field-label">Akun</span>
            <select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Semua akun</option>{ALL_ACCOUNTS.map((a) => <option key={a} value={a}>{ACCOUNT_LABEL[a] ?? a} ({a})</option>)}</select>
          </label>
          <label className="field"><span className="field-label">ID order (server)</span><input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="UUID order" /></label>
          <label className="field"><span className="field-label">Cari no. order / referensi / memo</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SO-2026-…, RET-…, PO-…" /></label>
          <label className="field"><span className="field-label">Limit</span><input type="number" min="1" max="5000" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
          <div className="form-actions"><button className="btn" type="submit">Terapkan</button></div>
        </form>
      </Card>
      {led.loading && <p>Memuat…</p>}
      {led.error && <Alert kind="error">{led.error}</Alert>}
      {led.data && (
        <Card title={<>Entri jurnal <small className="muted">({rows.length})</small></>}>
          {!rows.length ? <Empty /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Posted</th><th>Order</th><th>Jurnal</th><th>Akun</th><th>Komponen</th><th>Sisi</th><th className="num">Jumlah</th><th>Pihak</th><th>Memo</th></tr></thead>
                <tbody>
                  {rows.map((e: any) => (
                    <tr key={e.id}>
                      <td>{dt(e.posted_at)}</td>
                      <td>{e.order_id ? <Link to={`/orders/${e.order_id}`}>{e.order_no ?? e.order_id.slice(0, 8)}</Link> : <span className="muted">-</span>}</td>
                      <td>{e.journal_type}<br /><small className="muted">{e.reference}</small></td>
                      <td title={e.account}>{ACCOUNT_LABEL[e.account] ?? e.account}</td>
                      <td><code>{e.component}</code></td>
                      <td><Badge tone={e.side === 'DEBIT' ? '' : 'good'}>{e.side === 'DEBIT' ? 'DR' : 'CR'}</Badge></td>
                      <td className="num">{rupiah(e.amount)}</td>
                      <td>{e.party_type ?? '-'}</td>
                      <td>{e.memo ?? '-'}</td>
                    </tr>
                  ))}
                  <tr className="total"><td colSpan={6}>Total debit / kredit (baris tampil)</td><td className="num">{rupiah(totals.d)} / {rupiah(totals.c)}</td><td colSpan={2}>{Math.abs(totals.d - totals.c) < 0.01 ? <Badge tone="good">seimbang</Badge> : <small className="muted">difilter — tidak harus seimbang</small>}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function AuditLog() {
  const logs = useAsync(() => api.get('/api/admin/audit-logs?limit=500'));
  const [entity, setEntity] = useState('');
  const [search, setSearch] = useState('');
  const all: any[] = logs.data ?? [];
  const entities = Array.from(new Set(all.map((a) => a.entity))).sort();
  const rows = all.filter((a) => (!entity || a.entity === entity) && (!search || `${a.entity_id} ${a.user_name ?? ''} ${a.reason ?? ''} ${a.action}`.toLowerCase().includes(search.toLowerCase())));
  return (
    <Card title={<>Audit log konfigurasi <small className="muted">({rows.length})</small></>} actions={<>
      <select value={entity} onChange={(e) => setEntity(e.target.value)} style={{ width: 200 }}><option value="">Semua entitas</option>{entities.map((e) => <option key={e} value={e}>{e}</option>)}</select>
      <input placeholder="Cari ID / pengguna / alasan" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
    </>}>
      {logs.loading && <p>Memuat…</p>}
      {logs.error && <Alert kind="error">{logs.error}</Alert>}
      {logs.data && !rows.length && <Empty>Belum ada perubahan konfigurasi yang tercatat.</Empty>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Waktu</th><th>Pengguna</th><th>Entitas</th><th>ID</th><th>Aksi</th><th>Alasan</th><th>Perubahan (before → after)</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{dt(a.created_at)}</td>
                  <td>{a.user_name ?? <span className="muted">sistem</span>}</td>
                  <td><code>{a.entity}</code></td>
                  <td><small>{String(a.entity_id).length > 14 ? String(a.entity_id).slice(0, 8) + '…' : a.entity_id}</small></td>
                  <td><Badge tone={a.action === 'CREATE' ? 'good' : a.action === 'REJECT' ? 'bad' : ''}>{a.action}</Badge></td>
                  <td>{a.reason ?? '-'}</td>
                  <td><DiffCell before={a.before} after={a.after} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Ledger() {
  const { tab, setTab } = useTabs('reconcile');
  return (
    <>
      <PageHead title="Ledger & Rekonsiliasi" desc="Jurnal double-entry per order (pembayaran, pengakuan pendapatan, penyesuaian retur, refund, payout) dan audit log konfigurasi." />
      <Tabs tabs={[{ key: 'reconcile', label: 'Rekonsiliasi' }, { key: 'journal', label: 'Jurnal' }, { key: 'audit', label: 'Audit log' }]} value={tab} onChange={setTab} />
      {tab === 'reconcile' && <Reconciliation />}
      {tab === 'journal' && <Journal />}
      {tab === 'audit' && <AuditLog />}
      <p className="footer-note">Formula rekonsiliasi: Money In + Receivables (klaim logistik) = Money Out + Liability + Tax + Net Revenue. Karena setiap jurnal wajib seimbang, variance harus 0; nilai lain menandakan bug posting, bukan selisih bisnis.</p>
    </>
  );
}
