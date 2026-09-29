import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dt, num, ORDER_STATUS_LABEL, rupiah } from '../../lib/api';
import { Alert, Badge, Card, Empty, statusTone, useAsync } from '../../components/ui';
import { Tabs } from './shared';

type TabKey = 'ACTION' | 'RUNNING' | 'DONE' | 'ALL';
const ACTION = ['DRAFT', 'PENDING_PAYMENT', 'ARRIVED_WAITING_INSPECTION'];
const RUNNING = ['PAID', 'PACKING', 'PICKED_UP', 'IN_TRANSIT', 'PARTIALLY_ACCEPTED', 'REJECTED', 'DISPUTED'];
const DONE = ['ACCEPTED', 'SETTLED', 'CANCELLED'];

const group = (s: string): TabKey => (ACTION.includes(s) ? 'ACTION' : RUNNING.includes(s) ? 'RUNNING' : DONE.includes(s) ? 'DONE' : 'RUNNING');

export default function Orders() {
  const [tab, setTab] = useState<TabKey>('ACTION');
  const { data, error, loading } = useAsync<any[]>(() => api.get('/api/orders'), []);
  const all = data ?? [];
  const rows = tab === 'ALL' ? all : all.filter((o) => group(o.status) === tab);
  const count = (k: TabKey) => (k === 'ALL' ? all.length : all.filter((o) => group(o.status) === k).length);

  return (
    <>
      <div className="page-head">
        <div><h1>Pesanan saya</h1><p>Status pesanan, pembayaran, dan inspeksi penerimaan.</p></div>
        <Link to="/buyer" className="btn secondary">Cari produk</Link>
      </div>
      <Card>
        <Tabs<TabKey>
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'ACTION', label: 'Perlu tindakan', count: count('ACTION') },
            { key: 'RUNNING', label: 'Berjalan', count: count('RUNNING') },
            { key: 'DONE', label: 'Selesai', count: count('DONE') },
            { key: 'ALL', label: 'Semua', count: count('ALL') },
          ]}
        />
        {error && <Alert kind="error">{error}</Alert>}
        {loading && <p className="muted">Memuat…</p>}
        {!loading && !rows.length && <Empty>Tidak ada pesanan pada kelompok ini.</Empty>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>No. order</th><th>Supplier</th><th>Produk</th><th className="num">Kuantitas</th><th className="num">Total</th><th>Status</th><th>Dibuat</th></tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const arrived = o.status === 'ARRIVED_WAITING_INSPECTION';
                  return (
                    <tr key={o.id} style={arrived ? { background: 'var(--warn-2)' } : undefined}>
                      <td><Link to={`/orders/${o.id}`}><b>{o.order_no}</b></Link><br /><small className="muted">{o.batch_code}</small></td>
                      <td>{o.supplier_name}</td>
                      <td>{o.product_name}</td>
                      <td className="num">{num(o.quantity, 3)} {o.unit}</td>
                      <td className="num">{rupiah(o.total_amount)}</td>
                      <td>
                        <Badge tone={statusTone(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
                        {arrived && <><br /><small style={{ color: 'var(--warn)' }}>Barang tiba — lakukan inspeksi</small></>}
                        {o.status === 'DRAFT' && <><br /><small className="muted">Konfirmasi untuk mengunci harga</small></>}
                        {o.status === 'PENDING_PAYMENT' && <><br /><small className="muted">Menunggu pembayaran Anda</small></>}
                      </td>
                      <td>{dt(o.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
