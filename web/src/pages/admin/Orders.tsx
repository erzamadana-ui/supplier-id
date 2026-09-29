import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupiah, num, pct, dt, ORDER_STATUS_LABEL } from '../../lib/api';
import { Card, Stat, Badge, statusTone, Alert, Empty, useAsync } from '../../components/ui';
import { PageHead } from './shared';

const GROUPS: { label: string; statuses: string[]; tone?: 'good' | 'warn' | 'bad' | 'muted' }[] = [
  { label: 'Draft / menunggu bayar', statuses: ['DRAFT', 'PENDING_PAYMENT'], tone: 'muted' },
  { label: 'Dibayar & proses', statuses: ['PAID', 'PACKING', 'PICKED_UP', 'IN_TRANSIT'] },
  { label: 'Menunggu inspeksi', statuses: ['ARRIVED_WAITING_INSPECTION'], tone: 'warn' },
  { label: 'Diterima', statuses: ['ACCEPTED', 'PARTIALLY_ACCEPTED'], tone: 'good' },
  { label: 'Ditolak / dispute', statuses: ['REJECTED', 'DISPUTED'], tone: 'bad' },
  { label: 'Settled', statuses: ['SETTLED'], tone: 'good' },
  { label: 'Dibatalkan', statuses: ['CANCELLED'], tone: 'muted' },
];

export default function Orders() {
  const orders = useAsync(() => api.get('/api/orders'));
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const all: any[] = orders.data ?? [];
  const rows = all.filter((o) => (!status || o.status === status) && (!text || `${o.order_no} ${o.buyer_name ?? ''} ${o.supplier_name ?? ''} ${o.product_name ?? ''} ${o.batch_code ?? ''}`.toLowerCase().includes(text.toLowerCase())));
  const totals = rows.reduce((a, o) => ({ gmv: a.gmv + Number(o.total_amount || 0), fee: a.fee + Number(o.platform_fee_amount || 0) }), { gmv: 0, fee: 0 });

  return (
    <>
      <PageHead title="Semua Order" desc="Seluruh order lintas buyer dan supplier. Klik nomor order untuk detail, jurnal ledger, dan bukti." />
      {orders.error && <Alert kind="error">{orders.error}</Alert>}
      {orders.loading && <p>Memuat…</p>}
      {orders.data && (
        <>
          <div className="stats">
            <Stat label="Total order" value={num(all.length)} />
            {GROUPS.map((g) => {
              const n = all.filter((o) => g.statuses.includes(o.status)).length;
              return <Stat key={g.label} label={g.label} value={num(n)} tone={n ? g.tone : 'muted'} hint={g.statuses.map((s) => ORDER_STATUS_LABEL[s] ?? s).join(' · ')} />;
            })}
          </div>
          <Card
            title={<>Daftar order <small className="muted">({rows.length})</small></>}
            actions={
              <>
                <input placeholder="Cari no. order / buyer / supplier / produk" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 280 }} />
                <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 220 }}>
                  <option value="">Semua status</option>
                  {Object.entries(ORDER_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </>
            }
          >
            {!rows.length ? <Empty>Tidak ada order yang cocok.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>No. order</th><th>Buyer</th><th>Supplier</th><th>Produk</th><th className="num">Qty</th><th className="num">Fee rate</th><th className="num">Platform fee</th><th className="num">Total</th><th>Status</th><th>Dibuat</th></tr></thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.id}>
                        <td><Link to={`/orders/${o.id}`}><b>{o.order_no}</b></Link>{o.batch_code && <><br /><small className="muted">{o.batch_code}</small></>}</td>
                        <td>{o.buyer_name ?? '-'}</td>
                        <td>{o.supplier_name ?? '-'}</td>
                        <td>{o.product_name ?? '-'}</td>
                        <td className="num">{num(o.quantity)} {o.unit}</td>
                        <td className="num">{pct(o.platform_fee_rate)}</td>
                        <td className="num">{rupiah(o.platform_fee_amount)}</td>
                        <td className="num">{rupiah(o.total_amount)}</td>
                        <td><Badge tone={statusTone(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge></td>
                        <td>{dt(o.created_at)}</td>
                      </tr>
                    ))}
                    <tr className="total"><td colSpan={6}>Total ({rows.length} order, termasuk yang belum dibayar/batal)</td><td className="num">{rupiah(totals.fee)}</td><td className="num">{rupiah(totals.gmv)}</td><td colSpan={2}></td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <p className="footer-note">Fee rate per order adalah nilai yang terkunci saat konfirmasi (pricing snapshot), bukan fee yang berlaku saat ini.</p>
    </>
  );
}
