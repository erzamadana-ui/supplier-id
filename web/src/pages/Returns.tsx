import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dt, FAULT_LABEL, num, RETURN_STATUS_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Card, Empty, statusTone, useAsync } from '../components/ui';
import { Tabs } from './buyer/shared';

type TabKey = 'REVIEW' | 'DECIDED' | 'LOGISTICS' | 'CLOSED' | 'ALL';
const GROUP: Record<string, TabKey> = {
  REQUESTED: 'REVIEW', EVIDENCE_REVIEW: 'REVIEW',
  APPROVED: 'DECIDED', PARTIALLY_APPROVED: 'DECIDED', REJECTED: 'DECIDED',
  PICKUP_SCHEDULED: 'LOGISTICS', IN_TRANSIT: 'LOGISTICS', RECEIVED_BY_SUPPLIER: 'LOGISTICS',
  CLOSED: 'CLOSED',
};
const DISPUTE_LABEL: Record<string, string> = { OPEN: 'Dispute dibuka', UNDER_REVIEW: 'Dispute ditinjau', RESOLVED: 'Dispute selesai' };

export default function Returns() {
  const { user } = useAuth();
  const role = user?.role ?? 'BUYER';
  const [tab, setTab] = useState<TabKey>('REVIEW');
  const { data, error, loading } = useAsync<any[]>(() => api.get('/api/returns'), []);
  const all = data ?? [];
  const rows = tab === 'ALL' ? all : all.filter((r) => (GROUP[r.status] ?? 'ALL') === tab);
  const count = (k: TabKey) => (k === 'ALL' ? all.length : all.filter((r) => GROUP[r.status] === k).length);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{role === 'BUYER' ? 'Retur & klaim' : 'Retur & dispute'}</h1>
          <p>{role === 'ADMIN' ? 'Tinjau bukti, putuskan atribusi penyebab, dan pantau logistik retur.' : role === 'SUPPLIER' ? 'Klaim retur atas pesanan Anda — ajukan pernyataan jika tidak setuju.' : 'Klaim retur yang Anda ajukan dan statusnya.'}</p>
        </div>
      </div>
      <Card>
        <Tabs<TabKey>
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'REVIEW', label: role === 'ADMIN' ? 'Perlu keputusan' : 'Dalam review', count: count('REVIEW') },
            { key: 'DECIDED', label: 'Diputus', count: count('DECIDED') },
            { key: 'LOGISTICS', label: 'Logistik retur', count: count('LOGISTICS') },
            { key: 'CLOSED', label: 'Selesai', count: count('CLOSED') },
            { key: 'ALL', label: 'Semua', count: count('ALL') },
          ]}
        />
        {error && <Alert kind="error">{error}</Alert>}
        {loading && <p className="muted">Memuat…</p>}
        {!loading && !rows.length && <Empty>Tidak ada kasus retur pada kelompok ini.</Empty>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>No. kasus</th><th>Order</th><th>Produk</th>
                  {role !== 'SUPPLIER' && <th>Supplier</th>}
                  {role !== 'BUYER' && <th>Buyer</th>}
                  <th>Alasan</th><th className="num">Kuantitas</th><th>Status</th><th>Dispute</th><th>Atribusi</th><th>Dibuat</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/returns/${r.id}`}><b>{r.case_no}</b></Link></td>
                    <td><Link to={`/orders/${r.order_id}`}>{r.order_no}</Link></td>
                    <td>{r.product_name}</td>
                    {role !== 'SUPPLIER' && <td>{r.supplier_name}</td>}
                    {role !== 'BUYER' && <td>{r.buyer_name}</td>}
                    <td>{r.reason_label ?? r.reason_code}</td>
                    <td className="num">{num(r.quantity_affected, 3)} <small className="muted">/ {num(r.order_quantity, 3)} {r.unit}</small></td>
                    <td><Badge tone={statusTone(r.status)}>{RETURN_STATUS_LABEL[r.status] ?? r.status}</Badge></td>
                    <td>{r.dispute_status ? <Badge tone={r.dispute_status === 'RESOLVED' ? 'good' : 'bad'}>{DISPUTE_LABEL[r.dispute_status] ?? r.dispute_status}</Badge> : <span className="muted">-</span>}</td>
                    <td>{r.fault_attribution ? FAULT_LABEL[r.fault_attribution] ?? r.fault_attribution : <span className="muted">belum diputus</span>}</td>
                    <td>{dt(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
