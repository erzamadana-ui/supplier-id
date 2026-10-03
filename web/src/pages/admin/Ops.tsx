import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dt, errMsg, num, rupiah, PT_STATUS_LABEL, ORDER_STATUS_LABEL, hasPerm, remaining } from '../../lib/api';
import { Alert, AsyncButton, Badge, Card, Empty, Field, Stat, useAsync } from '../../components/ui';
import { PageHead } from './shared';
import { useAuth } from '../../lib/auth';

/** Tabel operasional: filter/search/sort/pagination/sticky header; kartu di layar sempit. */
export function OpsTable<T extends Record<string, any>>({ rows, cols, search = [], pageSize = 25, renderCard, exportName }: { rows: T[]; cols: { key: string; label: string; render?: (r: T) => any; num?: boolean; sortable?: boolean }[]; search?: string[]; pageSize?: number; renderCard?: (r: T) => any; exportName?: string }) {
  const [q, setQ] = useState(''); const [sort, setSort] = useState<{ k: string; d: 1 | -1 } | null>(null); const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    let r = rows;
    if (q) { const s = q.toLowerCase(); r = r.filter((x) => search.some((k) => String(x[k] ?? '').toLowerCase().includes(s))); }
    if (sort) r = [...r].sort((a, b) => (a[sort.k] > b[sort.k] ? 1 : a[sort.k] < b[sort.k] ? -1 : 0) * sort.d);
    return r;
  }, [rows, q, sort, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); const view = filtered.slice((page - 1) * pageSize, page * pageSize);
  const exportCsv = () => { const head = cols.map((c) => c.label).join(','); const lines = filtered.map((r) => cols.map((c) => JSON.stringify(c.render ? String(c.render(r)?.props?.children ?? c.render(r)) : r[c.key] ?? '')).join(',')); const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${exportName ?? 'export'}.csv`; a.click(); };
  return (
    <>
      <div className="toolbar">{search.length > 0 && <input placeholder="Cari…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Cari" />}<small className="muted">{filtered.length} baris</small>{exportName && <button className="btn small secondary" onClick={exportCsv}>Ekspor CSV</button>}</div>
      <div className={`table-ops ${renderCard ? 'cards' : ''}`}>
        <table><thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'num' : ''} style={{ cursor: c.sortable === false ? 'default' : 'pointer' }} onClick={() => c.sortable !== false && setSort(sort?.k === c.key ? { k: c.key, d: sort.d === 1 ? -1 : 1 } : { k: c.key, d: 1 })}>{c.label}{sort?.k === c.key ? (sort.d === 1 ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
          <tbody>{view.map((r, i) => <tr key={r.id ?? i}>{cols.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}</tr>)}</tbody></table>
        {renderCard && view.map((r, i) => <div key={r.id ?? i} className="row-card">{renderCard(r)}</div>)}
        {!view.length && <Empty />}
      </div>
      {pages > 1 && <div className="pager"><button className="btn small secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span>Hal {page}/{pages}</span><button className="btn small secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button></div>}
    </>
  );
}

/** DASHBOARD OPS — actionable. */
export function OpsDashboard() {
  const d = useAsync<any>(() => api.get('/api/admin/ops-dashboard'), []);
  const x = d.data;
  return (
    <>
      <PageHead title="Operasional — hari ini" desc="Backlog per tahap, keterlambatan, QC, pengiriman, komplain, pembayaran mitra, rekonsiliasi. Klik kartu untuk bertindak." />
      {d.loading && !x && <div className="skeleton" style={{ minHeight: 120 }} />}
      {d.error && <Alert kind="error">{d.error}</Alert>}
      {x && (
        <>
          <div className="stats">
            <Stat label="Task terbuka" value={x.tasks.open} hint={`${x.tasks.needs_action} perlu tindakan`} />
            <Stat label="Task terlambat" value={x.tasks.overdue} tone={x.tasks.overdue ? 'bad' : 'good'} />
            <Stat label="QC gagal 30 hari" value={`${x.qc.rejects_30d} / ${x.qc.total_30d}`} tone={x.qc.rejects_30d ? 'warn' : 'good'} />
            <Stat label="Pengiriman aktif" value={x.delivery.active} hint={`${x.delivery.failed} gagal antar`} tone={x.delivery.failed ? 'bad' : undefined} />
            <Stat label="Tiket terbuka" value={x.tickets.open} hint={`${x.tickets.in_progress} diproses`} />
            <Stat label="Konfirmasi jatuh tempo < 2 jam" value={x.confirmations_due_soon} />
            <Stat label="Rekonsiliasi" value={x.reconciliation.balanced ? 'Seimbang' : `Selisih ${rupiah(x.reconciliation.variance)}`} tone={x.reconciliation.balanced ? 'good' : 'bad'} />
            <Stat label="Job terakhir" value={x.last_job ? dt(x.last_job.finished_at ?? x.last_job.started_at) : '-'} hint={x.last_job?.error ? 'ERROR' : x.last_job?.job_name} tone={x.last_job?.error ? 'bad' : undefined} />
          </div>
          <div className="grid cols-3">
            <Card title="Order per tahap">{x.orders_by_stage.length ? x.orders_by_stage.map((r: any) => <div key={r.status} className="row between"><span>{ORDER_STATUS_LABEL[r.status] ?? r.status}</span><b>{r.n}</b></div>) : <Empty />}<Link to="/admin/orders" className="btn small secondary" style={{ marginTop: 8 }}>Semua order</Link></Card>
            <Card title="Payment task">{x.payment_tasks.map((r: any) => <div key={r.status} className="row between"><span>{PT_STATUS_LABEL[r.status]}{r.overdue ? <small className="inline-error"> · {r.overdue} lewat SLA</small> : ''}</span><b>{r.n} · {rupiah(r.amount)}</b></div>)}<Link to="/admin/finance" className="btn small secondary" style={{ marginTop: 8 }}>Finance → payment task</Link></Card>
            <Card title="Eskalasi terbuka">{x.escalations.length ? x.escalations.map((r: any) => <div key={r.kind} className="row between"><span>{r.kind}</span><b>{r.n}</b></div>) : <Empty>Tidak ada eskalasi.</Empty>}<Link to="/admin/escalations" className="btn small secondary" style={{ marginTop: 8 }}>Tangani eskalasi</Link></Card>
          </div>
        </>
      )}
    </>
  );
}

/** ESKALASI — mitra menolak/terlambat, bukti tidak valid, konfirmasi lewat tenggat, gagal antar, payout gagal, selisih berat. */
export function Escalations() {
  const [status, setStatus] = useState('OPEN');
  const e = useAsync<any[]>(() => api.get(`/api/admin/escalations?status=${status}`), [status]);
  const [res, setRes] = useState<Record<string, string>>({});
  return (
    <>
      <PageHead title="Eskalasi" desc="Setiap eskalasi berisi order, task, alasan. Selesaikan dengan tindakan nyata (batal/refund, verifikasi bukti, ops-confirm, kirim ulang, reassign) lalu tutup dengan catatan." actions={<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">Terbuka</option><option value="RESOLVED">Selesai</option></select>} />
      {e.error && <Alert kind="error">{e.error}</Alert>}
      {e.data && <OpsTable rows={e.data} search={['order_no', 'kind', 'reason', 'supplier_name', 'buyer_name']} exportName="eskalasi" cols={[
        { key: 'created_at', label: 'Waktu', render: (r) => <small>{dt(r.created_at)}</small> },
        { key: 'kind', label: 'Jenis', render: (r) => <Badge tone="warn">{r.kind}</Badge> },
        { key: 'order_no', label: 'Order', render: (r) => r.order_id ? <Link to={`/orders/${r.order_id}`}>{r.order_no}</Link> : '-' },
        { key: 'reason', label: 'Alasan / konteks', render: (r) => <>{r.reason}<br /><small className="muted">{r.supplier_name} → {r.buyer_name} · {ORDER_STATUS_LABEL[r.order_status] ?? r.order_status}{r.task_no ? ` · ${r.task_no}` : ''}</small></> },
        { key: 'actions', label: 'Tindakan', sortable: false, render: (r) => r.status === 'OPEN' ? (
          <div className="row">
            {r.kind === 'CONFIRMATION_OVERDUE' && <AsyncButton className="btn small" confirm="Konfirmasi atas nama pelanggan? Payment task akan dibuat." onClick={async () => { await api.post(`/api/admin/orders/${r.order_id}/ops-confirm`, { note: res[r.id] || 'Dikonfirmasi ops' }); await e.reload(); }}>Ops-confirm</AsyncButton>}
            {['SUPPLIER_REJECTED', 'NO_RESPONSE', 'SUPPLIER_LATE', 'DELIVERY_FAILED', 'QC_FAILED'].includes(r.kind) && <AsyncButton className="btn small danger" confirm="Batalkan order & refund pelanggan?" onClick={async () => { await api.post(`/api/orders/${r.order_id}/cancel`, { reason: res[r.id] || `Eskalasi ${r.kind}` }); await e.reload(); }}>Batal + refund</AsyncButton>}
            <input placeholder="catatan penyelesaian" value={res[r.id] ?? ''} onChange={(ev) => setRes({ ...res, [r.id]: ev.target.value })} style={{ width: 170 }} />
            <AsyncButton className="btn small secondary" disabled={(res[r.id] ?? '').length < 3} onClick={async () => { await api.post(`/api/admin/escalations/${r.id}/resolve`, { resolution: res[r.id], clear_hold: true }); await e.reload(); }}>Tutup</AsyncButton>
          </div>
        ) : <small>{r.resolution} · {dt(r.resolved_at)}</small> },
      ]} />}
    </>
  );
}

/** DISPATCH — order siap pickup → tugaskan kurir; shipment aktif; verifikasi bukti foto. */
export function Dispatch() {
  const d = useAsync<any>(() => api.get('/api/dispatch/ready'), []);
  const [courier, setCourier] = useState<Record<string, string>>({});
  return (
    <>
      <PageHead title="Dispatch & kurir" desc="Tugaskan kurir ke order yang sudah dikemas & berlabel. OTP penerimaan dikirim ke pelanggan saat penugasan." />
      {d.error && <Alert kind="error">{d.error}</Alert>}
      {d.data && (
        <>
          <Card title={`Siap pickup (${d.data.ready.length})`}>
            {!d.data.ready.length && <Empty>Tidak ada order siap pickup.</Empty>}
            {d.data.ready.map((o: any) => (
              <div key={o.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div><Link to={`/orders/${o.id}`}><b>{o.order_no}</b></Link> · {o.product_name} · {num(o.quantity)} {o.unit} · {o.packages} paket<br /><small className="muted">Jemput: {o.supplier_name}, {o.supplier_address ?? o.region ?? '-'} · Antar: {o.delivery_address} · janji pickup {dt(o.promised_pickup_at)} ({remaining(o.promised_pickup_at)})</small></div>
                <div className="row"><select value={courier[o.id] ?? ''} onChange={(e) => setCourier({ ...courier, [o.id]: e.target.value })}><option value="">— kurir —</option>{d.data.couriers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <AsyncButton className="btn small" disabled={!courier[o.id]} onClick={async () => { await api.post(`/api/dispatch/orders/${o.id}/assign`, { courier_user_id: courier[o.id] }); await d.reload(); }}>Tugaskan</AsyncButton></div>
              </div>
            ))}
          </Card>
          <Card title={`Pengiriman aktif (${d.data.active.length})`}>
            <OpsTable rows={d.data.active} search={['order_no', 'courier_name', 'buyer_name', 'status']} cols={[
              { key: 'order_no', label: 'Order', render: (r) => <Link to={`/orders/${r.order_id}`}>{r.order_no}</Link> },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'DELIVERY_FAILED' ? 'bad' : undefined}>{r.status}</Badge> },
              { key: 'courier_name', label: 'Kurir' }, { key: 'buyer_name', label: 'Penerima', render: (r) => <>{r.buyer_name}<br /><small className="muted">{r.delivery_address}</small></> },
              { key: 'packages', label: 'Paket', render: (r) => (r.packages ?? []).map((p: any) => `${p.package_no} (${p.status})`).join(', ') },
              { key: 'failed_attempts', label: 'Gagal', num: true },
            ]} />
          </Card>
          <EvidenceVerification />
        </>
      )}
    </>
  );
}
function EvidenceVerification() {
  const e = useAsync<any[]>(() => api.get('/api/admin/escalations?status=OPEN'), []);
  const rows = (e.data ?? []).filter((x) => x.kind === 'EVIDENCE_INVALID');
  const [note, setNote] = useState<Record<string, string>>({});
  if (!rows.length) return null;
  return (
    <Card title={`Verifikasi bukti penerimaan kurir (${rows.length})`}>
      {rows.map((r) => <ShipmentEvidenceRow key={r.id} esc={r} note={note[r.id] ?? ''} setNote={(v) => setNote({ ...note, [r.id]: v })} onDone={e.reload} />)}
    </Card>
  );
}
function ShipmentEvidenceRow({ esc, note, setNote, onDone }: { esc: any; note: string; setNote: (v: string) => void; onDone: () => void }) {
  const o = useAsync<any>(() => api.get(`/api/orders/${esc.order_id}`), [esc.order_id]);
  const ship = (o.data?.shipments ?? []).filter((s: any) => s.type === 'DELIVERY').slice(-1)[0];
  const proofs = (o.data?.evidence ?? []).filter((x: any) => x.kind === 'DELIVERY_PROOF');
  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
      <div className="row between"><div><Link to={`/orders/${esc.order_id}`}><b>{esc.order_no}</b></Link> · penerima: {ship?.recipient_name ?? '-'} · {proofs.length} foto<br /><small className="muted">{esc.reason}</small></div>
        <div className="row"><input placeholder="catatan" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 160 }} />
          {ship && <AsyncButton className="btn small" onClick={async () => { await api.post(`/api/admin/shipments/${ship.id}/verify-evidence`, { valid: true, note }); onDone(); }}>Sah → mulai jendela 24 jam</AsyncButton>}
          {ship && <AsyncButton className="btn small danger" disabled={note.length < 3} onClick={async () => { await api.post(`/api/admin/shipments/${ship.id}/verify-evidence`, { valid: false, note }); onDone(); }}>Tidak sah</AsyncButton>}</div></div>
      {proofs.length > 0 && <div className="gallery" style={{ marginTop: 6 }}>{proofs.map((p: any) => <figure key={p.id}><img src={p.file_path.startsWith('http') ? p.file_path : `/uploads/${p.file_path}`} alt="bukti" /></figure>)}</div>}
    </div>
  );
}

/** FINANCE — payment task maker/checker. Tombol tampil sesuai izin; server tetap memvalidasi. */
export function Finance() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const t = useAsync<any>(() => api.get(`/api/finance/payment-tasks${status ? `?status=${status}` : ''}`), [status]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const canMake = hasPerm(user, 'payouts.make'), canCheck = hasPerm(user, 'payouts.check'), canProcess = hasPerm(user, 'payouts.process');
  const r = (id: string) => reason[id] ?? '';
  const act = async (fn: () => Promise<any>) => { await fn(); await t.reload(); };
  return (
    <>
      <PageHead title="Finance → Payment task (pembayaran mitra)" desc={`Maker mengajukan → Checker (≠ maker) menyetujui → proses ke provider (${t.data?.provider ?? '…'}) → PAID hanya dari bukti provider/bank. SLA ${t.data?.sla_hours ?? 24} jam setelah disetujui.`}
        actions={<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Semua status</option>{Object.entries(PT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>} />
      {t.data?.provider === 'NONE' && <Alert kind="warn">Provider payout = NONE: transfer dilakukan manual oleh finance, lalu checker mencatat bukti bank (mark-paid). Atur di Konfigurasi → <code>payout.provider</code> setelah akun provider & izin tersedia.</Alert>}
      {t.error && <Alert kind="error">{t.error}</Alert>}
      {t.data && (
        <>
          <div className="stats">{Object.entries(t.data.counts).map(([k, v]) => <Stat key={k} label={PT_STATUS_LABEL[k] ?? k} value={v as number} />)}</div>
          <OpsTable rows={t.data.tasks} search={['task_no', 'order_no', 'supplier_name', 'status']} exportName="payment-tasks" cols={[
            { key: 'task_no', label: 'Task', render: (x) => <><code>{x.task_no}</code><br /><small className="muted">{x.trigger} · {dt(x.created_at)}</small></> },
            { key: 'order_no', label: 'Order / mitra', render: (x) => <><Link to={`/orders/${x.order_id}`}>{x.order_no}</Link><br /><small className="muted">{x.supplier_name} · {x.trade_model}</small></> },
            { key: 'net_amount', label: 'Neto', num: true, render: (x) => <><b>{rupiah(x.net_amount)}</b><br /><small className="muted">bruto {rupiah(x.gross_amount)} · adj {rupiah(x.adjustment_amount)}</small></> },
            { key: 'status', label: 'Status', render: (x) => <><Badge tone={x.status === 'PAID' ? 'good' : ['FAILED', 'REVERSED', 'ON_HOLD', 'REJECTED'].includes(x.status) ? 'bad' : x.status === 'PENDING_APPROVAL' ? 'warn' : undefined}>{PT_STATUS_LABEL[x.status]}</Badge>{x.hold_reason && <><br /><small className="inline-error">{x.hold_reason}</small></>}{x.due_at && ['APPROVED', 'PROCESSING'].includes(x.status) && <><br /><small className={remaining(x.due_at) === 'habis' ? 'inline-error' : 'muted'}>SLA {remaining(x.due_at)}</small></>}</> },
            { key: 'maker_name', label: 'Maker / checker', render: (x) => <small>{x.maker_name ?? '-'} / {x.checker_name ?? '-'}{x.provider_ref ? <><br />ref {x.provider_ref}</> : ''}{x.is_sandbox && x.payout_no ? <><br /><Badge tone="warn">SANDBOX</Badge></> : ''}</small> },
            { key: 'actions', label: 'Tindakan', sortable: false, render: (x) => (
              <div className="row">
                {canMake && ['CREATED', 'REJECTED'].includes(x.status) && x.bank_snapshot && <AsyncButton className="btn small" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/submit`))}>Ajukan</AsyncButton>}
                {['CREATED', 'REJECTED'].includes(x.status) && !x.bank_snapshot && <small className="inline-error">Rekening mitra belum ada</small>}
                {canCheck && x.status === 'PENDING_APPROVAL' && x.maker_id !== user?.id && <AsyncButton className="btn small" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/approve`))}>Setujui</AsyncButton>}
                {canCheck && x.status === 'PENDING_APPROVAL' && x.maker_id === user?.id && <small className="muted">Anda maker — perlu checker lain</small>}
                {canCheck && x.status === 'PENDING_APPROVAL' && x.maker_id !== user?.id && <AsyncButton className="btn small danger" disabled={r(x.id).length < 3} onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/reject`, { reason: r(x.id) }))}>Tolak</AsyncButton>}
                {canProcess && x.status === 'APPROVED' && t.data.provider !== 'NONE' && <AsyncButton className="btn small" confirm="Kirim transfer ke provider?" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/process`))}>Proses transfer</AsyncButton>}
                {canCheck && ['APPROVED', 'PROCESSING'].includes(x.status) && t.data.provider === 'NONE' && x.maker_id !== user?.id && <AsyncButton className="btn small" disabled={r(x.id).length < 3} confirm="Catat sebagai DIBAYAR dengan bukti bank ini?" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/mark-paid`, { bank_ref: r(x.id) }))}>Catat dibayar (ref bank)</AsyncButton>}
                {(canProcess || canCheck) && x.status === 'PROCESSING' && t.data.provider !== 'NONE' && <AsyncButton className="btn small secondary" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/inquiry`))}>Inquiry</AsyncButton>}
                {canCheck && x.status === 'PAID' && <AsyncButton className="btn small danger" disabled={r(x.id).length < 3} confirm="Reversal membalik jurnal payout & membuka eskalasi. Lanjutkan?" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/reverse`, { reason: r(x.id) }))}>Reversal</AsyncButton>}
                {(canMake || canCheck) && ['CREATED', 'PENDING_APPROVAL', 'APPROVED'].includes(x.status) && <AsyncButton className="btn small secondary" disabled={r(x.id).length < 3} onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/hold`, { reason: r(x.id) }))}>Tahan</AsyncButton>}
                {canCheck && x.status === 'ON_HOLD' && <AsyncButton className="btn small secondary" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/release`))}>Lepas hold</AsyncButton>}
                {canCheck && x.status === 'FAILED' && <AsyncButton className="btn small secondary" onClick={() => act(() => api.post(`/api/finance/payment-tasks/${x.id}/release`))}>Tinjau ulang → dibuat</AsyncButton>}
                <input placeholder="alasan / ref bank" value={r(x.id)} onChange={(e) => setReason({ ...reason, [x.id]: e.target.value })} style={{ width: 150 }} />
              </div>
            ) },
          ]} />
        </>
      )}
    </>
  );
}

/** STAF & KURIR — peran granular, maker ≠ checker. */
export function Staff() {
  const u = useAsync<any[]>(() => api.get('/api/admin/users'), []);
  const roles = useAsync<any>(() => api.get('/api/admin/roles'), []);
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'ADMIN', admin_role: 'OPS', phone: '' });
  const [err, setErr] = useState(''); const [ok, setOk] = useState('');
  return (
    <>
      <PageHead title="Staf admin & kurir" desc="Peran: OWNER, OPS, QC, WAREHOUSE, DISPATCHER, CS, FINANCE_MAKER, FINANCE_CHECKER, AUDITOR, serta KURIR. Izin ditegakkan server; satu orang dapat memegang beberapa peran bisnis, tetapi maker dan checker selalu dua akun berbeda." />
      {err && <Alert kind="error">{err}</Alert>}{ok && <Alert kind="success">{ok}</Alert>}
      <div className="grid cols-2">
        <Card title="Tambah staf / kurir">
          <Field label="Nama" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email" required><input type="email" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Kata sandi awal (≥8, minta diganti)" required><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <div className="grid cols-2">
            <Field label="Jenis"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="ADMIN">Staf admin</option><option value="COURIER">Kurir</option></select></Field>
            {f.role === 'ADMIN' && <Field label="Peran admin"><select value={f.admin_role} onChange={(e) => setF({ ...f, admin_role: e.target.value })}>{Object.keys(roles.data ?? {}).map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>}
            <Field label="Telepon"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </div>
          {f.role === 'ADMIN' && roles.data && <p className="muted"><small>Izin {f.admin_role}: {(roles.data[f.admin_role] ?? []).join(', ')}</small></p>}
          <AsyncButton onClick={async () => { setErr(''); setOk(''); try { await api.post('/api/admin/users', { ...f, admin_role: f.role === 'ADMIN' ? f.admin_role : undefined }); setOk(`${f.name} dibuat.`); setF({ ...f, email: '', name: '', password: '' }); await u.reload(); } catch (e) { setErr(errMsg(e)); throw e; } }}>Buat akun</AsyncButton>
        </Card>
        <Card title="Daftar">
          {u.data && <OpsTable rows={u.data} search={['name', 'email', 'role', 'admin_role']} cols={[
            { key: 'name', label: 'Nama', render: (x) => <>{x.name}<br /><small className="muted">{x.email}</small></> },
            { key: 'role', label: 'Peran', render: (x) => <Badge>{x.role === 'COURIER' ? 'KURIR' : x.admin_role ?? 'OWNER'}</Badge> },
            { key: 'active', label: 'Aktif', render: (x) => <AsyncButton className={`btn small ${x.active ? 'secondary' : ''}`} onClick={async () => { await api.patch(`/api/admin/users/${x.id}`, { active: !x.active }); await u.reload(); }}>{x.active ? 'Nonaktifkan' : 'Aktifkan'}</AsyncButton> },
            { key: 'last_login_at', label: 'Login terakhir', render: (x) => <small>{dt(x.last_login_at)}</small> },
          ]} />}
        </Card>
      </div>
    </>
  );
}
