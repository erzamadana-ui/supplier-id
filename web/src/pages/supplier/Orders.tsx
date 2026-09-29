import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupiah, num, dt, errMsg, ORDER_STATUS_LABEL } from '../../lib/api';
import { Card, Badge, statusTone, Alert, Field, Empty, AsyncButton, useAsync } from '../../components/ui';
import { compact } from './shared';

type Tab = 'action' | 'shipping' | 'done' | 'all';
const ACTION = ['PAID', 'PACKING'];
const SHIPPING = ['PICKED_UP', 'IN_TRANSIT', 'ARRIVED_WAITING_INSPECTION'];
const DONE = ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'DISPUTED', 'SETTLED', 'CANCELLED'];
const TABS: { key: Tab; label: string; match: (s: string) => boolean }[] = [
  { key: 'action', label: 'Perlu tindakan', match: (s) => ACTION.includes(s) },
  { key: 'shipping', label: 'Dalam pengiriman', match: (s) => SHIPPING.includes(s) },
  { key: 'done', label: 'Selesai', match: (s) => DONE.includes(s) },
  { key: 'all', label: 'Semua', match: () => true },
];

function PackAction({ order, onDone }: { order: any; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('Karung/Box standar');
  const [cost, setCost] = useState('');
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Packing</button>;
  return (
    <div className="row" style={{ gap: 6 }}>
      <input style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value)} placeholder="Jenis packaging" />
      <input style={{ width: 130 }} type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Biaya aktual (Rp)" title="Kosongkan untuk memakai biaya packaging dari pricing snapshot" />
      <AsyncButton className="btn small" onClick={async () => { await api.post(`/api/orders/${order.id}/pack`, compact({ packaging_type: type, actual_packaging_cost: cost })); setOpen(false); await onDone(); }}>Tandai packing</AsyncButton>
      <button className="btn secondary small" onClick={() => setOpen(false)}>Batal</button>
    </div>
  );
}

function PickupAction({ order, onDone }: { order: any; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({ carrier: 'Supplier.id Logistics Partner', driver_name: '', vehicle: '', cold_chain: false, logistics_cost: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Pickup</button>;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post(`/api/orders/${order.id}/pickup`, { ...compact({ carrier: f.carrier, driver_name: f.driver_name, vehicle: f.vehicle, logistics_cost: f.logistics_cost }), cold_chain: !!f.cold_chain }); setOpen(false); await onDone(); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <form className="inline" onSubmit={submit} style={{ minWidth: 420 }}>
      <Field label="Kurir / carrier" required><input required value={f.carrier} onChange={(e) => set('carrier', e.target.value)} /></Field>
      <Field label="Nama driver"><input value={f.driver_name} onChange={(e) => set('driver_name', e.target.value)} /></Field>
      <Field label="Kendaraan / nopol"><input value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)} placeholder="cth. Pick-up BA 1234 XX" /></Field>
      <Field label="Biaya logistik aktual (Rp)" hint="Kosongkan = pakai estimasi snapshot"><input type="number" min={0} value={f.logistics_cost} onChange={(e) => set('logistics_cost', e.target.value)} /></Field>
      <div className="field"><span className="field-label">Cold chain</span><label className="row" style={{ gap: 6, paddingTop: 6 }}><input type="checkbox" checked={f.cold_chain} onChange={(e) => set('cold_chain', e.target.checked)} /> Pengiriman berpendingin</label></div>
      <div className="form-actions">
        <button className="btn small" disabled={busy}>{busy ? '…' : 'Konfirmasi pickup'}</button>
        <button type="button" className="btn secondary small" onClick={() => setOpen(false)}>Batal</button>
        {err && <small className="inline-error">{err}</small>}
      </div>
    </form>
  );
}

/** Aksi saat barang dalam perjalanan: tambah event tracking & tandai tiba. Butuh shipment id dari detail order. */
function TransitActions({ order, onDone }: { order: any; onDone: () => Promise<void> }) {
  const detail = useAsync<any>(() => api.get(`/api/orders/${order.id}`), [order.id, order.status]);
  const [f, setF] = useState<any>({ event_type: 'CHECKPOINT', location: '', temperature_c: '', note: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [ok, setOk] = useState('');
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const shipments: any[] = (detail.data?.shipments ?? []).filter((s: any) => s.type === 'DELIVERY');
  const shipment = shipments.length ? shipments[shipments.length - 1] : null;
  if (detail.loading) return <small>Memuat shipment…</small>;
  if (detail.error) return <small className="inline-error">{detail.error}</small>;
  if (!shipment) return <small className="inline-error">Shipment tidak ditemukan untuk order ini.</small>;
  const addEvent = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setOk('');
    try {
      await api.post(`/api/shipments/${shipment.id}/events`, compact(f));
      setOk('Event tracking ditambahkan.'); setF({ event_type: 'CHECKPOINT', location: '', temperature_c: '', note: '' });
      await detail.reload(); await onDone();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const events: any[] = shipment.events ?? [];
  return (
    <div style={{ minWidth: 420 }}>
      <small className="muted">Shipment <code>{shipment.tracking_no}</code> · {shipment.carrier}{shipment.driver_name ? ` · ${shipment.driver_name}` : ''}{shipment.cold_chain ? ' · cold chain' : ''} · {events.length} event</small>
      {events.length > 0 && (
        <ul style={{ margin: '4px 0 6px', paddingLeft: 16, fontSize: 12 }}>
          {events.slice(-3).map((ev) => <li key={ev.id}>{dt(ev.occurred_at)} — <b>{ev.event_type}</b>{ev.location ? ` @ ${ev.location}` : ''}{ev.temperature_c != null ? ` (${ev.temperature_c} °C)` : ''}{ev.note ? ` — ${ev.note}` : ''}</li>)}
        </ul>
      )}
      <form className="inline" onSubmit={addEvent}>
        <Field label="Jenis event">
          <select value={f.event_type} onChange={(e) => set('event_type', e.target.value)}>
            <option value="CHECKPOINT">Checkpoint</option><option value="TEMPERATURE">Suhu</option><option value="DELAY">Keterlambatan</option>
          </select>
        </Field>
        <Field label="Lokasi"><input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="cth. Tol Padang–Pekanbaru KM 40" /></Field>
        <Field label="Suhu (°C)"><input type="number" step="any" value={f.temperature_c} onChange={(e) => set('temperature_c', e.target.value)} /></Field>
        <Field label="Catatan"><input value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
        <div className="form-actions">
          <button className="btn secondary small" disabled={busy}>{busy ? '…' : 'Tambah event tracking'}</button>
          <AsyncButton className="btn small" confirm="Tandai barang tiba di lokasi buyer? Status berubah menjadi menunggu inspeksi buyer." onClick={async () => { await api.post(`/api/shipments/${shipment.id}/arrive`); await onDone(); }}>Tiba di buyer</AsyncButton>
          {err && <small className="inline-error">{err}</small>}
          {ok && <small style={{ color: 'var(--good)' }}>{ok}</small>}
        </div>
      </form>
    </div>
  );
}

export default function Orders() {
  const ordersQ = useAsync<any[]>(() => api.get('/api/orders'));
  const [tab, setTab] = useState<Tab>('action');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const orders = ordersQ.data ?? [];
  const reload = async () => { await ordersQ.reload(); };
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, orders.filter((o) => t.match(o.status)).length])), [orders]);
  const rows = orders.filter((o) => TABS.find((t) => t.key === tab)!.match(o.status));
  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pesanan</h1>
          <p>Fulfilment: Dibayar → Packing → Pickup → Dalam perjalanan (live tracking) → Tiba di buyer → Inspeksi buyer.</p>
        </div>
        <button className="btn secondary small" onClick={reload}>Muat ulang</button>
      </div>
      {ordersQ.error && <Alert kind="error">{ordersQ.error}</Alert>}
      <Card>
        <div className="tabs">
          {TABS.map((t) => <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label} ({counts[t.key] ?? 0})</button>)}
        </div>
        {ordersQ.loading ? <p>Memuat…</p> : rows.length === 0 ? <Empty>Tidak ada pesanan pada kelompok ini.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>No. order</th><th>Buyer</th><th>Produk</th><th className="num">Qty</th><th>Status</th><th className="num">Product value</th><th>Dibuat</th><th>Janji pickup</th><th>Tindakan</th></tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const late = o.promised_pickup_at && !o.picked_up_at && new Date(o.promised_pickup_at) < new Date() && ['PAID', 'PACKING'].includes(o.status);
                  const inTransit = ['PICKED_UP', 'IN_TRANSIT'].includes(o.status);
                  return (
                    <tr key={o.id}>
                      <td><Link to={`/orders/${o.id}`}><b>{o.order_no}</b></Link><br /><small>{o.batch_code}</small></td>
                      <td>{o.buyer_name}</td>
                      <td>{o.product_name}</td>
                      <td className="num">{num(o.quantity, 2)} {o.unit}</td>
                      <td><Badge tone={statusTone(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge></td>
                      <td className="num">{rupiah(o.product_value)}<br /><small>total {rupiah(o.total_amount)}</small></td>
                      <td>{dt(o.created_at)}</td>
                      <td>{dt(o.promised_pickup_at)}{late && <><br /><Badge tone="bad">Terlambat</Badge></>}</td>
                      <td>
                        {o.status === 'PAID' && <PackAction order={o} onDone={reload} />}
                        {o.status === 'PACKING' && <PickupAction order={o} onDone={reload} />}
                        {inTransit && (
                          !expanded[o.id]
                            ? <button className="btn small" onClick={() => toggle(o.id)}>Tracking / tiba</button>
                            : <><button className="btn secondary small" onClick={() => toggle(o.id)} style={{ marginBottom: 6 }}>Tutup</button><TransitActions order={o} onDone={reload} /></>
                        )}
                        {o.status === 'ARRIVED_WAITING_INSPECTION' && <small className="muted">Menunggu inspeksi buyer</small>}
                        {o.status === 'PENDING_PAYMENT' && <small className="muted">Menunggu pembayaran buyer</small>}
                        {DONE.includes(o.status) && <Link className="btn secondary small" to={`/orders/${o.id}`}>Detail</Link>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="footer-note">Keterlambatan pickup (picked_up_at &gt; promised_pickup_at) dihitung ke late fulfillment rate pada Quality Score. Biaya packaging/logistik aktual yang diisi menggantikan estimasi snapshot untuk perhitungan margin platform.</p>
    </>
  );
}
