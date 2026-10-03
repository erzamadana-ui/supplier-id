import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, dt, errMsg, hasPerm } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, AsyncButton, Badge, Card, Empty, Field, useAsync } from '../components/ui';
import { PublicLayout } from '../components/PublicLayout';

const CAT: Record<string, string> = { COMPLAINT: 'Komplain barang', REFUND: 'Refund', DELIVERY: 'Pengiriman', PAYMENT: 'Pembayaran', OTHER: 'Lainnya' };
const ST: Record<string, string> = { OPEN: 'Terbuka', IN_PROGRESS: 'Diproses', WAITING_CUSTOMER: 'Menunggu Anda', ESCALATED: 'Dieskalasi', RESOLVED: 'Selesai', CLOSED: 'Ditutup' };
const Wrap = ({ children }: { children: any }) => { const { user } = useAuth(); return user?.role === 'BUYER' ? <PublicLayout searchable={false}>{children}</PublicLayout> : <>{children}</>; };

export default function Tickets() {
  const { user } = useAuth();
  const t = useAsync<any[]>(() => api.get('/api/tickets'), []);
  return (
    <Wrap>
      <div className="page-head"><div><h1>{user?.role === 'ADMIN' ? 'Tiket customer service' : 'Bantuan & tiket'}</h1><p>Setiap tiket terhubung ke pesanan; keputusan refund tercatat di kasus retur.</p></div>{user?.role !== 'ADMIN' && <Link to="/tiket/baru" className="btn">+ Tiket baru</Link>}</div>
      {t.error && <Alert kind="error">{t.error}</Alert>}
      {t.data && !t.data.length && <Empty>Belum ada tiket.</Empty>}
      {t.data?.map((x) => <Link key={x.id} to={`/tiket/${x.id}`} className="task-card"><div className="stage">{x.priority}</div><div><b>{x.subject}</b> · <Badge>{CAT[x.category]}</Badge><br /><small className="muted">{x.ticket_no} · {x.order_no ?? 'tanpa order'} · {x.buyer_name ?? ''} · {dt(x.created_at)}</small></div><Badge tone={['RESOLVED', 'CLOSED'].includes(x.status) ? 'good' : x.status === 'ESCALATED' ? 'bad' : undefined}>{ST[x.status]}</Badge></Link>)}
    </Wrap>
  );
}

export function NewTicket() {
  const [sp] = useSearchParams(); const nav = useNavigate();
  const [f, setF] = useState({ order_id: sp.get('order_id') ?? '', category: 'COMPLAINT', subject: '', body: '' }); const [err, setErr] = useState('');
  return (
    <Wrap>
      <h1>Tiket baru</h1>
      {err && <Alert kind="error">{err}</Alert>}
      <Card>
        <Field label="ID pesanan (opsional)"><input value={f.order_id} onChange={(e) => setF({ ...f, order_id: e.target.value })} /></Field>
        <Field label="Kategori"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Judul" required><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Uraian" required><textarea rows={4} style={{ fontFamily: 'inherit' }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <p className="muted"><small>Komplain barang yang terkait pesanan akan menahan pembayaran mitra sampai tiket ditutup. Untuk klaim barang tidak sesuai saat tiba, gunakan formulir inspeksi di halaman pesanan (wajib foto + video).</small></p>
        <AsyncButton onClick={async () => { setErr(''); try { const t = await api.post('/api/tickets', { ...f, order_id: f.order_id || undefined }); nav(`/tiket/${t.id}`); } catch (e) { setErr(errMsg(e)); throw e; } }}>Kirim tiket</AsyncButton>
      </Card>
    </Wrap>
  );
}

export function TicketDetail() {
  const { id } = useParams(); const { user } = useAuth();
  const t = useAsync<any>(() => api.get(`/api/tickets/${id}`), [id]);
  const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [res, setRes] = useState('');
  const d = t.data; const canManage = hasPerm(user, 'tickets.manage');
  if (t.error) return <Wrap><Alert kind="error">{t.error}</Alert></Wrap>;
  if (!d) return <Wrap><p className="muted">Memuat…</p></Wrap>;
  return (
    <Wrap>
      <div className="page-head"><div><small className="muted"><Link to="/tiket">Tiket</Link> / {d.ticket_no}</small><h1>{d.subject} <Badge tone={['RESOLVED', 'CLOSED'].includes(d.status) ? 'good' : undefined}>{ST[d.status]}</Badge></h1><p>{CAT[d.category]} · {d.order_id ? <Link to={`/orders/${d.order_id}`}>{d.order_no}</Link> : 'tanpa order'} · {d.buyer_name ?? ''} {d.supplier_name ? `· mitra ${d.supplier_name}` : ''} · {dt(d.created_at)}{d.assignee_name ? ` · PIC ${d.assignee_name}` : ''}</p></div></div>
      <div className="grid cols-2">
        <Card title="Percakapan">
          {d.messages.map((m: any) => <div key={m.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', background: m.internal ? 'var(--warn-2)' : undefined }}><b>{m.author_name ?? m.author_role}</b> <small className="muted">{dt(m.created_at)}{m.internal ? ' · internal' : ''}</small><br />{m.body}</div>)}
          {!['RESOLVED', 'CLOSED'].includes(d.status) && (
            <div style={{ marginTop: 10 }}>
              <textarea rows={3} style={{ fontFamily: 'inherit' }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Tulis balasan…" />
              <div className="row" style={{ marginTop: 6 }}>{user?.role === 'ADMIN' && <label className="row"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> catatan internal</label>}
                <AsyncButton disabled={body.length < 1} onClick={async () => { await api.post(`/api/tickets/${id}/messages`, { body, internal }); setBody(''); await t.reload(); }}>Kirim</AsyncButton></div>
            </div>
          )}
        </Card>
        <div>
          {canManage && (
            <Card title="Penanganan (CS)">
              <div className="row">{['IN_PROGRESS', 'WAITING_CUSTOMER', 'ESCALATED'].map((s) => <AsyncButton key={s} className="btn small secondary" onClick={async () => { await api.patch(`/api/tickets/${id}`, { status: s, assignee_id: user!.id }); await t.reload(); }}>{ST[s]}</AsyncButton>)}</div>
              <Field label="Resolusi"><input value={res} onChange={(e) => setRes(e.target.value)} /></Field>
              <AsyncButton disabled={res.length < 3} onClick={async () => { await api.patch(`/api/tickets/${id}`, { status: 'RESOLVED', resolution: res }); await t.reload(); }}>Tandai selesai</AsyncButton>
              {d.return_case_id && <p style={{ marginTop: 8 }}><Link to={`/returns/${d.return_case_id}`}>Buka kasus retur terkait →</Link></p>}
              {d.order_id && !d.return_case_id && <p className="muted" style={{ marginTop: 8 }}><small>Refund parsial/penuh diputuskan melalui kasus retur (bukti & atribusi), bukan dari tiket.</small></p>}
            </Card>
          )}
          {d.resolution && <Alert kind="success">Resolusi: {d.resolution}</Alert>}
        </div>
      </div>
    </Wrap>
  );
}
