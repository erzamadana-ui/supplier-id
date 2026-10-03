import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, dt, errMsg, num, rupiah, TASK_STAGE_LABEL, TASK_STATUS_LABEL, PKG_STATUS_LABEL, remaining, fileUrl } from '../../lib/api';
import { Alert, AsyncButton, Badge, Card, Empty, EvidenceGallery, Field, Timeline, useAsync } from '../../components/ui';
import { useAuth } from '../../lib/auth';

const TABS: [string, string, string][] = [
  ['baru', 'Baru / menunggu respons', 'NEW,AWAITING_RESPONSE'], ['kerja', 'Dikerjakan', 'IN_PROGRESS'], ['tindakan', 'Perlu tindakan', 'NEEDS_ACTION'], ['telat', 'Terlambat', 'LATE'], ['selesai', 'Selesai', 'DONE'], ['tolak', 'Ditolak/batal', 'REJECTED,CANCELLED'],
];
const STAGE_CODE: Record<string, string> = { ACCEPTANCE: 'TRM', PRODUCTION: 'PRD', PICKING: 'PCK', QC: 'QC', PACKING: 'PAK', HANDOVER: 'SRH' };

/** INBOX TASK MITRA — berorientasi tindakan: status, tenggat, dan aksi utama terlihat per kartu. */
export default function Tasks() {
  const [tab, setTab] = useState('baru');
  const status = TABS.find((t) => t[0] === tab)![2];
  const all = useAsync<any>(() => api.get('/api/tasks'), []);
  const list = useAsync<any>(() => api.get(`/api/tasks?status=${status}`), [status]);
  const counts = all.data?.counts ?? {};
  const countOf = (codes: string) => codes.split(',').reduce((s, c) => s + (counts[c] ?? 0), 0);
  return (
    <>
      <div className="page-head"><div><h1>Task inbox</h1><p>Pesanan masuk → terima → siapkan → QC & timbang → kemas & label → serahkan ke kurir. Status disahkan server.</p></div><button className="btn secondary small" onClick={() => { all.reload(); list.reload(); }}>Muat ulang</button></div>
      <div className="chips" role="tablist">{TABS.map(([k, label, codes]) => <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label} ({countOf(codes)})</button>)}</div>
      {list.loading && !list.data && <div className="skeleton" style={{ minHeight: 100 }} />}
      {list.error && <Alert kind="error">{list.error}</Alert>}
      {list.data && !list.data.tasks.length && <Empty>Tidak ada task pada kelompok ini.</Empty>}
      {list.data?.tasks.map((t: any) => (
        <Link key={t.id} to={`/supplier/tasks/${t.id}`} className={`task-card ${t.overdue || t.status === 'LATE' ? 'late' : t.status === 'NEEDS_ACTION' ? 'action' : ''}`}>
          <div className="stage" aria-label={TASK_STAGE_LABEL[t.stage]}>{STAGE_CODE[t.stage]}</div>
          <div>
            <b>{TASK_STAGE_LABEL[t.stage]}</b> · {t.product_name} · {num(t.quantity)} {t.unit}<br />
            <small className="muted">{t.order_no} · {t.buyer_name} · {t.task_no}</small><br />
            <span className="deadline">{t.deadline ? `Tenggat ${dt(t.deadline)} (${remaining(t.deadline)})` : 'Tanpa tenggat'}</span>
          </div>
          <div style={{ textAlign: 'right' }}><Badge tone={t.status === 'LATE' ? 'bad' : t.status === 'DONE' ? 'good' : t.status === 'NEEDS_ACTION' ? 'warn' : undefined}>{TASK_STATUS_LABEL[t.status]}</Badge><br /><small className="muted">prioritas {t.priority}</small></div>
        </Link>
      ))}
    </>
  );
}

/** DETAIL TASK — aksi per tahap. */
export function TaskDetail() {
  const { id } = useParams(); const nav = useNavigate(); const { user } = useAuth();
  const t = useAsync<any>(() => api.get(`/api/tasks/${id}`), [id]);
  const [err, setErr] = useState('');
  // Setelah aksi yang membuat task tahap berikutnya (terima, selesai kerja, QC lulus), langsung buka task berikutnya
  const act = async (fn: () => Promise<any>) => { setErr(''); try { const r = await fn(); if (r?.next?.id) { nav(`/supplier/tasks/${r.next.id}`); return r; } await t.reload(); return r; } catch (e) { setErr(errMsg(e)); throw e; } };
  const d = t.data;
  if (t.loading && !d) return <p className="muted">Memuat task…</p>;
  if (t.error) return <Alert kind="error">{t.error}</Alert>;
  if (!d) return null;
  const open = ['NEW', 'AWAITING_RESPONSE', 'IN_PROGRESS', 'NEEDS_ACTION', 'LATE'].includes(d.status);
  return (
    <>
      <div className="page-head">
        <div><small className="muted"><Link to="/supplier/tasks">Task inbox</Link> / {d.task_no}</small>
          <h1>{TASK_STAGE_LABEL[d.stage]} <Badge tone={d.status === 'LATE' ? 'bad' : d.status === 'DONE' ? 'good' : d.status === 'NEEDS_ACTION' ? 'warn' : undefined}>{TASK_STATUS_LABEL[d.status]}</Badge></h1>
          <p><b>{d.product_name}</b> · {num(d.quantity)} {d.unit}{d.weight_kg ? ` · ±${num(d.weight_kg, 2)} kg` : ''} · Pesanan <Link to={`/orders/${d.order_id}`}>{d.order_no}</Link> · {d.buyer_name}<br />
            <small className="muted">Tenggat: {d.deadline ? `${dt(d.deadline)} (${remaining(d.deadline)})` : '-'} · Pickup dijanjikan {dt(d.promised_pickup_at)} · Alamat kirim: {d.delivery_address ?? '-'}</small></p>
        </div>
      </div>
      {err && <Alert kind="error">{err}</Alert>}
      {d.instructions && <Alert kind="info">{d.instructions}</Alert>}
      <div className="steps">{d.pipeline.map((p: any) => <span key={p.id} className={p.status === 'DONE' ? 'done' : p.id === d.id ? 'now' : ''}>{TASK_STAGE_LABEL[p.stage]}</span>)}</div>

      <div className="grid cols-2">
        <div>
          <Card title="Tindakan">
            {!open && <p className="muted">Task sudah {TASK_STATUS_LABEL[d.status]?.toLowerCase()}.{d.reason ? ` Alasan: ${d.reason}` : ''}</p>}
            {open && d.stage === 'ACCEPTANCE' && <AcceptForm d={d} act={act} />}
            {open && ['PRODUCTION', 'PICKING'].includes(d.stage) && (
              <div className="row">
                {d.status !== 'IN_PROGRESS' && <AsyncButton className="btn secondary" onClick={() => act(() => api.post(`/api/tasks/${d.id}/start`))}>Mulai</AsyncButton>}
                <AsyncButton onClick={() => act(() => api.post(`/api/tasks/${d.id}/complete`, { result: { note: 'selesai' } }))} confirm="Tandai selesai dan lanjut ke QC?">Selesai → lanjut QC</AsyncButton>
              </div>
            )}
            {open && d.stage === 'QC' && <QcForm d={d} act={act} />}
            {open && d.stage === 'PACKING' && <PackingForm d={d} act={act} />}
            {open && d.stage === 'HANDOVER' && <HandoverPanel d={d} act={act} />}
          </Card>
          {d.qc_records.length > 0 && (
            <Card title="Catatan QC">
              {d.qc_records.map((r: any) => <div key={r.id} style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}><Badge tone={r.passed ? 'good' : 'bad'}>{r.passed ? 'Lulus' : 'Gagal'}</Badge> {dt(r.created_at)} · berat {r.measured_weight_kg ?? '-'} kg · suhu {r.measured_temperature_c ?? '-'}°C · grade {r.grade ?? '-'}{r.reject_reason ? ` · ${r.reject_reason}` : ''}</div>)}
              {d.weight_adjustment && <p style={{ marginTop: 8 }}><b>Berat aktual:</b> {d.weight_adjustment.status} {d.weight_adjustment.delta_pct != null ? `(${num(d.weight_adjustment.delta_pct, 1)}%)` : ''}</p>}
            </Card>
          )}
          {d.packages.length > 0 && (
            <Card title={`Paket (${d.packages.length})`}>
              {d.packages.map((p: any) => (
                <div key={p.id} className="row between" style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
                  <div><code>{p.package_no}</code> · {num(p.quantity)} {p.unit}{p.weight_kg ? ` · ${num(p.weight_kg, 2)} kg` : ''} · <Badge>{PKG_STATUS_LABEL[p.status]}</Badge><br /><small className="muted">label v{p.label_version} · dicetak {p.prints}×{p.expiry_date ? ` · exp ${p.expiry_date}` : ''}</small></div>
                  <div className="row"><Link to={`/labels/${p.id}`} className="btn small secondary">Cetak label</Link>{['PACKED', 'HANDED_OVER'].includes(p.status) && <AsyncButton className="btn small secondary" onClick={() => act(() => api.post(`/api/packages/${p.id}/cancel`, { reason: prompt('Alasan pembatalan paket') || 'Dibatalkan' }))}>Batalkan</AsyncButton>}</div>
                </div>
              ))}
            </Card>
          )}
        </div>
        <div>
          <Card title="Foto QC / packing"><EvidenceGallery files={d.evidence} emptyText="Belum ada foto." /></Card>
          <Card title="Riwayat"><Timeline items={d.events.map((e: any) => ({ at: e.created_at, title: `${TASK_STATUS_LABEL[e.to_status] ?? e.to_status}${e.actor_name ? ' · ' + e.actor_name : ''}`, note: e.note }))} /></Card>
        </div>
      </div>
    </>
  );
}

function AcceptForm({ d, act }: { d: any; act: (fn: () => Promise<any>) => Promise<any> }) {
  const [ready, setReady] = useState(''); const [reason, setReason] = useState('');
  return (
    <div className="grid cols-2">
      <div><Field label="Perkiraan siap (opsional)"><input type="datetime-local" value={ready} onChange={(e) => setReady(e.target.value)} /></Field>
        <AsyncButton onClick={() => act(() => api.post(`/api/tasks/${d.id}/accept`, { ready_at: ready ? new Date(ready).toISOString() : undefined }))}>Terima pesanan</AsyncButton></div>
      <div><Field label="Tolak — alasan (wajib)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. stok rusak" /></Field>
        <AsyncButton className="btn danger" disabled={reason.length < 3} confirm="Menolak pesanan akan dieskalasi ke operasional (batal + refund atau pesan ulang). Lanjutkan?" onClick={() => act(() => api.post(`/api/tasks/${d.id}/reject`, { reason }))}>Tolak pesanan</AsyncButton></div>
    </div>
  );
}

function QcForm({ d, act }: { d: any; act: (fn: () => Promise<any>) => Promise<any> }) {
  const [f, setF] = useState({ measured_quantity: String(d.quantity ?? ''), measured_weight_kg: '', measured_temperature_c: '', grade: '', notes: '', reject_reason: '' });
  const [file, setFile] = useState<File | null>(null); const [up, setUp] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const upload = async () => { if (!file) return; setUp('…'); try { await api.upload(file, { owner_type: 'QC', kind: 'QC_PHOTO', order_id: d.order_id, taken_at: new Date().toISOString() }); setUp('Foto terunggah ✓'); setFile(null); await act(async () => null); } catch (e) { setUp(errMsg(e)); } };
  const photos = d.evidence.filter((e: any) => e.owner_type === 'QC').length;
  return (
    <>
      <p className="muted"><small>Timbang berat aktual. Di dalam toleransi → harga tetap; kurang → refund otomatis ke pelanggan (mitra menanggung); lebih → pelanggan diminta menyetujui sebelum packing.</small></p>
      <div className="grid cols-2">
        <Field label="Kuantitas aktual"><input type="number" inputMode="decimal" value={f.measured_quantity} onChange={set('measured_quantity')} /></Field>
        <Field label="Berat aktual (kg)" hint={d.weight_kg ? `estimasi ${num(d.weight_kg, 2)} kg` : undefined}><input type="number" inputMode="decimal" step="0.01" value={f.measured_weight_kg} onChange={set('measured_weight_kg')} /></Field>
        <Field label="Suhu (°C)"><input type="number" inputMode="decimal" value={f.measured_temperature_c} onChange={set('measured_temperature_c')} /></Field>
        <Field label="Grade"><input value={f.grade} onChange={set('grade')} /></Field>
      </div>
      <Field label="Catatan"><input value={f.notes} onChange={set('notes')} /></Field>
      <Field label={`Foto QC (wajib ≥1, terunggah ${photos})`}><div className="row"><input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><button className="btn small secondary" disabled={!file} onClick={upload}>Unggah</button>{up && <small>{up}</small>}</div></Field>
      <div className="row">
        <AsyncButton disabled={photos === 0} onClick={() => act(() => api.post(`/api/tasks/${d.id}/qc`, { ...num3(f), passed: true }))}>QC lulus → lanjut packing</AsyncButton>
        <input placeholder="alasan gagal" value={f.reject_reason} onChange={set('reject_reason')} style={{ width: 200 }} />
        <AsyncButton className="btn danger" disabled={photos === 0 || f.reject_reason.length < 3} onClick={() => act(() => api.post(`/api/tasks/${d.id}/qc`, { ...num3(f), passed: false }))}>QC gagal</AsyncButton>
      </div>
    </>
  );
}
const num3 = (f: any) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? undefined : (k.startsWith('measured') ? Number(v) : v)]));

function PackingForm({ d, act }: { d: any; act: (fn: () => Promise<any>) => Promise<any> }) {
  const packed = d.packages.filter((p: any) => p.status !== 'CANCELLED').reduce((s: number, p: any) => s + Number(p.quantity), 0);
  const left = Math.max(0, Number(d.quantity) - packed);
  const [f, setF] = useState({ quantity: String(left), weight_kg: '', shelf_life_days: '', storage_instructions: '' });
  const pending = d.weight_adjustment?.status === 'PENDING_CUSTOMER';
  return (
    <>
      {pending && <Alert kind="warn">Menunggu keputusan pelanggan atas selisih berat. Packing dilanjutkan setelah pelanggan menyetujui atau meminta kemas ulang.</Alert>}
      <p className="muted"><small>Dikemas {num(packed)} dari {num(d.quantity)} {d.unit}. Setiap paket mendapat ID unik & label (QR + Code 128). Cetak label sebelum menyelesaikan packing.</small></p>
      {left > 0 && (
        <div className="grid cols-2">
          <Field label={`Kuantitas paket (${d.unit})`}><input type="number" inputMode="decimal" step="0.01" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
          <Field label="Berat paket (kg)"><input type="number" inputMode="decimal" step="0.01" value={f.weight_kg} onChange={(e) => setF({ ...f, weight_kg: e.target.value })} /></Field>
          <Field label="Masa simpan (hari)" hint="kosong = default kategori"><input type="number" value={f.shelf_life_days} onChange={(e) => setF({ ...f, shelf_life_days: e.target.value })} /></Field>
          <Field label="Instruksi penyimpanan"><input value={f.storage_instructions} onChange={(e) => setF({ ...f, storage_instructions: e.target.value })} placeholder="mis. simpan 2–5°C" /></Field>
          <div><AsyncButton disabled={pending} onClick={() => act(() => api.post(`/api/tasks/${d.id}/packages`, { quantity: Number(f.quantity), weight_kg: f.weight_kg ? Number(f.weight_kg) : undefined, shelf_life_days: f.shelf_life_days ? Number(f.shelf_life_days) : undefined, storage_instructions: f.storage_instructions || undefined }))}>+ Buat paket</AsyncButton></div>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <AsyncButton disabled={pending || left > 0} onClick={() => act(() => api.post(`/api/tasks/${d.id}/complete-packing`))}>Selesai packing → siap pickup</AsyncButton>
        {left > 0 && <small className="muted">Sisa {num(left)} {d.unit} belum dikemas.</small>}
      </div>
    </>
  );
}

function HandoverPanel({ d, act }: { d: any; act: (fn: () => Promise<any>) => Promise<any> }) {
  const [code, setCode] = useState(''); const [log, setLog] = useState<any[]>([]);
  const scan = async () => { const r = await api.post('/api/scan', { code, action: 'HANDOVER' }).catch((e) => e?.details ?? { result: 'REJECTED', reason: errMsg(e) }); setLog([r, ...log]); setCode(''); await act(async () => null); };
  return (
    <>
      <p className="muted"><small>Pindai/ketik ID paket saat menyerahkan ke kurir. Kurir memindai ulang untuk pickup. Task selesai otomatis saat semua paket diserahkan.</small></p>
      <div className="scan-box"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PKG-2026-000001" onKeyDown={(e) => e.key === 'Enter' && scan()} /><button className="btn" onClick={scan} disabled={code.length < 5}>Serahkan paket</button></div>
      <ul className="scan-log">{log.map((l, i) => <li key={i} className={l.result === 'OK' ? 'muted' : 'inline-error'}>{l.code ?? ''} — {l.result}{l.reason ? ` (${l.reason})` : ''}</li>)}</ul>
    </>
  );
}

/** Pembayaran mitra (payment task) — tampil di dashboard mitra. */
export function SupplierPaymentTasks() {
  const t = useAsync<any>(() => api.get('/api/supplier/payment-tasks'), []);
  return (
    <Card title="Pembayaran per pesanan (payment task)">
      <p className="muted"><small>Dibuat otomatis saat pelanggan mengonfirmasi penerimaan (atau 24 jam tanpa respons). Transfer diproses maksimal {t.data?.sla_hours ?? 24} jam setelah disetujui finance.</small></p>
      {t.loading && !t.data && <div className="skeleton" />}
      {t.data && !t.data.tasks.length && <Empty>Belum ada payment task.</Empty>}
      {t.data?.tasks.length > 0 && (
        <div className="table-wrap"><table><thead><tr><th>Task</th><th>Pesanan</th><th className="num">Bruto</th><th className="num">Penyesuaian</th><th className="num">Neto</th><th>Status</th><th>Jatuh tempo / dibayar</th></tr></thead>
          <tbody>{t.data.tasks.map((x: any) => <tr key={x.id}><td><code>{x.task_no}</code></td><td>{x.order_no}<br /><small className="muted">{x.product_name}</small></td><td className="num">{rupiah(x.gross_amount)}</td><td className="num">{rupiah(x.adjustment_amount)}</td><td className="num"><b>{rupiah(x.net_amount)}</b></td><td><Badge tone={x.status === 'PAID' ? 'good' : ['FAILED', 'REVERSED', 'ON_HOLD'].includes(x.status) ? 'bad' : undefined}>{x.status}</Badge>{x.hold_reason && <><br /><small className="inline-error">{x.hold_reason}</small></>}</td><td><small>{x.paid_at ? `Dibayar ${dt(x.paid_at)} · ${x.provider_ref ?? ''}` : x.due_at ? `Target ${dt(x.due_at)}` : '-'}</small></td></tr>)}</tbody></table></div>
      )}
    </Card>
  );
}
