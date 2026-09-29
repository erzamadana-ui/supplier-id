import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupiah, num, dt } from '../../lib/api';
import { Card, Stat, Badge, Alert, AsyncButton, Empty, useAsync } from '../../components/ui';
import { PageHead } from './shared';

export default function Payouts() {
  const data = useAsync(() => api.get('/api/admin/payouts'));
  const [flash, setFlash] = useState('');
  const pending: any[] = data.data?.pending ?? [];
  const history: any[] = data.data?.history ?? [];
  const totalPayable = pending.reduce((a, p) => a + Number(p.payable_balance || 0), 0);
  const readyCount = pending.filter((p) => Number(p.payable_balance) > 0 && Number(p.settled_unpaid_orders) > 0).length;
  const paidTotal = history.filter((h) => h.status === 'PAID').reduce((a, h) => a + Number(h.amount || 0), 0);

  return (
    <>
      <PageHead title="Payout Supplier" desc="Pembayaran hak bersih supplier. Payout hanya untuk order berstatus SETTLED; nilainya adalah hak bersih setelah adjustment retur." />
      <Alert kind="info">
        <b>Aturan payout:</b> hanya order <Badge tone="good">SETTLED</Badge> yang belum dibayar yang dicairkan; jumlah = saldo <code>SUPPLIER_PAYABLE</code> per order (nilai produk dikurangi potongan retur/refund yang sudah diputuskan). Saldo dari order yang belum settled tetap tertahan. Setiap payout dicatat sebagai jurnal <code>SUPPLIER_PAYOUT</code> (DR utang supplier / CR kas).
      </Alert>
      {flash && <Alert kind="success">{flash}</Alert>}
      {data.loading && <p>Memuat…</p>}
      {data.error && <Alert kind="error">{data.error}</Alert>}
      {data.data && (
        <>
          <div className="stats">
            <Stat label="Total utang ke supplier" value={rupiah(totalPayable)} hint="Saldo SUPPLIER_PAYABLE semua supplier (termasuk order belum settled)" />
            <Stat label="Siap dibayar" value={num(readyCount)} tone={readyCount ? 'warn' : 'muted'} hint="Supplier dengan order SETTLED belum dibayar" />
            <Stat label="Sudah dibayarkan" value={rupiah(paidTotal)} tone="good" hint={`${history.length} payout`} />
          </div>

          <Card title="Menunggu payout">
            {!pending.length ? <Empty>Belum ada supplier.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Supplier</th><th>Rekening</th><th className="num">Saldo hak (payable)</th><th className="num">Order SETTLED belum dibayar</th><th>Keterangan</th><th></th></tr></thead>
                  <tbody>
                    {pending.map((p) => {
                      const ready = Number(p.payable_balance) > 0 && Number(p.settled_unpaid_orders) > 0;
                      return (
                        <tr key={p.supplier_id}>
                          <td><b>{p.supplier_name}</b></td>
                          <td>{p.bank_account ?? <Badge tone="warn">rekening belum diisi</Badge>}</td>
                          <td className="num">{rupiah(p.payable_balance)}</td>
                          <td className="num">{num(p.settled_unpaid_orders)}</td>
                          <td>
                            {ready ? <Badge tone="warn">Siap dibayar</Badge>
                              : Number(p.payable_balance) > 0 ? <small className="muted">Saldo ada, tetapi belum ada order SETTLED — menunggu inspeksi/retur selesai</small>
                              : <small className="muted">Tidak ada saldo</small>}
                          </td>
                          <td>
                            <AsyncButton
                              className="btn small"
                              disabled={!ready}
                              confirm={`Bayar sekarang ke ${p.supplier_name} (${p.bank_account ?? 'rekening tidak ada'})?\nHanya order SETTLED yang belum dibayar akan dicairkan; jumlah final dihitung server dari ledger.`}
                              onClick={async () => {
                                const r = await api.post('/api/admin/payouts/run', { supplier_id: p.supplier_id });
                                setFlash(`Payout ${r.payout_no} sebesar ${rupiah(r.amount)} ke ${p.supplier_name} tercatat (${(r.order_ids ?? []).length} order, ref ${r.bank_ref}).`);
                                await data.reload();
                              }}
                            >Bayar sekarang</AsyncButton>
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="total"><td colSpan={2}>Total</td><td className="num">{rupiah(totalPayable)}</td><td className="num">{num(pending.reduce((a, p) => a + Number(p.settled_unpaid_orders || 0), 0))}</td><td colSpan={2}></td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Riwayat payout">
            {!history.length ? <Empty>Belum ada payout.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>No. payout</th><th>Supplier</th><th className="num">Jumlah</th><th>Status</th><th>Dibayar</th><th>Ref. bank</th><th className="num">Order</th><th>Jurnal</th></tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td><b>{h.payout_no}</b></td>
                        <td>{h.supplier_name}</td>
                        <td className="num">{rupiah(h.amount)}</td>
                        <td><Badge tone={h.status === 'PAID' ? 'good' : h.status === 'FAILED' ? 'bad' : 'warn'}>{h.status}</Badge></td>
                        <td>{dt(h.paid_at)}</td>
                        <td><code>{h.bank_ref ?? '-'}</code></td>
                        <td className="num" title={(h.order_ids ?? []).join('\n')}>{num((h.order_ids ?? []).length)} order</td>
                        <td><Link to="/admin/ledger">{h.journal_id ? String(h.journal_id).slice(0, 8) + '…' : '-'}</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <p className="footer-note">Transfer bank di MVP disimulasikan (bank_ref otomatis); integrasi disbursement nyata belum ada. Saldo negatif per order (potongan retur melebihi hak) tidak dicairkan dan tetap tercatat di ledger.</p>
    </>
  );
}
