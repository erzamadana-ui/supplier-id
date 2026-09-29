import { Link } from 'react-router-dom';
import { api, rupiah, num, pct, dt, d, ORDER_STATUS_LABEL } from '../../lib/api';
import { Card, Stat, Badge, statusTone, Alert, Empty, useAsync } from '../../components/ui';

const ORG_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Aktif', WARNING: 'Peringatan', VERIFICATION_REQUIRED: 'Perlu verifikasi tambahan', LISTING_LIMITED: 'Listing dibatasi',
  UNDER_REVIEW: 'Dalam review', SUSPENDED: 'Ditangguhkan',
};
const ENFORCEMENT_ACTION_LABEL: Record<string, string> = {
  WARNING: 'Peringatan', RANK_DOWN: 'Peringkat diturunkan', ADDITIONAL_VERIFICATION: 'Verifikasi tambahan', LISTING_LIMITED: 'Listing dibatasi', ACCOUNT_REVIEW: 'Review akun',
};

function MetricRow({ label, value, invert }: { label: string; value: any; invert?: boolean }) {
  // invert=true: nilai tinggi = buruk (rate retur, keterlambatan). default: nilai tinggi = baik.
  const v = Number(value);
  const tone = isNaN(v) ? '' : invert ? (v > 20 ? 'bad' : v > 10 ? 'warn' : 'good') : (v >= 90 ? 'good' : v >= 75 ? 'warn' : 'bad');
  return (
    <tr>
      <td>{label}</td>
      <td className="num"><Badge tone={tone}>{pct(value)}</Badge></td>
    </tr>
  );
}

export default function Dashboard() {
  const dash = useAsync(() => api.get('/api/supplier/dashboard'));
  const reminders = useAsync(() => api.get('/api/supplier/harvest/reminders'));

  if (dash.loading) return <p>Memuat…</p>;
  if (dash.error) return <Alert kind="error">{dash.error}</Alert>;
  const data = dash.data ?? {};
  const s = data.summary ?? {};
  const org = data.organization ?? {};
  const quality = data.quality;
  const metrics = quality?.metrics ?? {};
  const enforcement = quality?.enforcement ?? {};
  const orders: any[] = data.orders ?? [];
  const payouts: any[] = data.payouts ?? [];
  const rem: any[] = reminders.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard &amp; Payout</h1>
          <p>Nilai produk yang menjadi hak Anda, potongan retur/refund, serta status pembayaran per pesanan.</p>
        </div>
        <div className="row">
          <Badge tone={statusTone(org.status)}>{ORG_STATUS_LABEL[org.status] ?? org.status ?? '-'}</Badge>
          {org.verified && <Badge tone="good">Terverifikasi</Badge>}
        </div>
      </div>

      {org.status && org.status !== 'ACTIVE' && (
        <Alert kind={['SUSPENDED', 'UNDER_REVIEW'].includes(org.status) ? 'error' : 'warn'}>
          <b>Status akun: {ORG_STATUS_LABEL[org.status] ?? org.status}.</b> {org.status_reason ? `Alasan: ${org.status_reason}.` : ''}{' '}
          {org.status === 'LISTING_LIMITED' && 'Anda hanya dapat mempublikasikan 1 listing aktif sampai status dipulihkan.'}
          {['SUSPENDED', 'UNDER_REVIEW'].includes(org.status) && 'Publikasi listing dan penawaran RFQ dinonaktifkan sementara.'}
        </Alert>
      )}

      {reminders.error && <Alert kind="error">Gagal memuat pengingat panen: {reminders.error}</Alert>}
      {rem.length > 0 && (
        <Alert kind="warn">
          <b>PRE-HARVEST QUALITY UPDATE diperlukan</b> — {rem.length} batch panen mendekati tanggal panen dan belum diperbarui kondisinya (foto terbaru + kondisi terkini wajib sebelum panen):
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {rem.map((h) => (
              <li key={h.batch_id}>
                <Link to={`/supplier/batches/${h.batch_id}`}>{h.batch_code}</Link> — {h.product_name}, perkiraan panen {d(h.expected_harvest_date)}, estimasi {num(h.expected_quantity)}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="stats">
        <Stat label="Product Value" value={rupiah(s.product_value)} hint="Total nilai produk semua pesanan (non-draft)" />
        <Stat label="Adjustment" value={rupiah(s.adjustment)} tone={Number(s.adjustment) > 0 ? 'bad' : 'muted'} hint="Potongan retur/refund yang dibebankan ke Anda" />
        <Stat label="Supplier Receivable" value={rupiah(s.supplier_receivable)} tone="good" hint="Hak bersih Anda (termasuk yang sudah dibayar)" />
        <Stat label="Paid" value={rupiah(s.paid)} hint="Sudah ditransfer (payout PAID)" />
        <Stat label="Pending" value={rupiah(s.pending)} tone={Number(s.pending) > 0 ? 'warn' : 'muted'} hint="Belum dibayar — menunggu settlement/payout" />
      </div>

      <div className="grid cols-2">
        <Card title="Supplier Quality Score">
          {!quality ? (
            <Empty>Skor belum dihitung — akan tersedia setelah ada pesanan yang selesai atau panen yang difinalisasi.</Empty>
          ) : (
            <>
              <div className="row between" style={{ marginBottom: 10 }}>
                <div>
                  <div className="stat-label">Skor (0–100)</div>
                  <div className="stat-value" style={{ fontSize: 30 }}>{num(quality.score, 2)}</div>
                  <small>dihitung {dt(quality.computed_at)}</small>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-label">Enforcement</div>
                  <Badge tone={statusTone(enforcement.status)}>{ORG_STATUS_LABEL[enforcement.status] ?? enforcement.status ?? '-'}</Badge>
                  <div style={{ marginTop: 6 }}>
                    {(enforcement.actions ?? []).length === 0
                      ? <small>Tidak ada tindakan</small>
                      : (enforcement.actions as string[]).map((a) => <Badge key={a} tone="warn">{ENFORCEMENT_ACTION_LABEL[a] ?? a}</Badge>)}
                  </div>
                  {enforcement.note && <div><small>{enforcement.note}</small></div>}
                </div>
              </div>
              <table>
                <tbody>
                  <MetricRow label="Return rate" value={metrics.return_rate} invert />
                  <MetricRow label="Buyer acceptance rate" value={metrics.buyer_acceptance_rate} />
                  <MetricRow label="Late fulfillment rate" value={metrics.late_fulfillment_rate} invert />
                  <MetricRow label="Declaration accuracy (panen)" value={metrics.declaration_accuracy} />
                  <MetricRow label="Damage rate" value={metrics.damage_rate} invert />
                  <MetricRow label="Quality mismatch rate" value={metrics.quality_mismatch_rate} invert />
                  <MetricRow label="Dispute rate" value={metrics.dispute_rate} invert />
                  <tr><td>Total order / berhasil</td><td className="num">{num(metrics.total_orders)} / {num(metrics.successful_orders)}</td></tr>
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card title="Profil organisasi">
          <dl className="kv">
            <dt>Nama</dt><dd>{org.name ?? '-'}</dd>
            <dt>Jenis</dt><dd>{org.supplier_kind ?? '-'}</dd>
            <dt>Status pajak</dt><dd>{org.tax_status ?? '-'}</dd>
            <dt>Wilayah</dt><dd>{org.region ?? '-'}</dd>
            <dt>Rekening payout</dt><dd>{org.bank_account ?? '-'}</dd>
            <dt>Status</dt><dd><Badge tone={statusTone(org.status)}>{ORG_STATUS_LABEL[org.status] ?? org.status}</Badge> {org.status_reason && <small>— {org.status_reason}</small>}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Hak per pesanan" actions={<Link className="btn secondary small" to="/supplier/orders">Kelola pesanan</Link>}>
        {orders.length === 0 ? <Empty>Belum ada pesanan.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>No. order</th><th>Produk</th><th>Buyer</th><th>Status</th>
                  <th className="num">Qty / diterima / ditolak</th>
                  <th className="num">Product value</th><th className="num">Potongan retur</th><th className="num">Hak supplier</th><th className="num">Dibayar</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/orders/${o.id}`}>{o.order_no}</Link><br /><small>{dt(o.created_at)}</small></td>
                    <td>{o.product_name}</td>
                    <td>{o.buyer_name}</td>
                    <td><Badge tone={statusTone(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge></td>
                    <td className="num">{num(o.quantity, 2)} / {o.accepted_quantity == null ? '-' : num(o.accepted_quantity, 2)} / {o.rejected_quantity == null ? '-' : num(o.rejected_quantity, 2)}</td>
                    <td className="num">{rupiah(o.product_value)}</td>
                    <td className="num" style={{ color: Number(o.return_deduction) > 0 ? 'var(--danger)' : undefined }}>{Number(o.return_deduction) > 0 ? '-' : ''}{rupiah(o.return_deduction)}</td>
                    <td className="num"><b>{rupiah(o.supplier_receivable)}</b></td>
                    <td className="num">{rupiah(o.paid)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={5}>Total</td>
                  <td className="num">{rupiah(orders.reduce((a, o) => a + Number(o.product_value || 0), 0))}</td>
                  <td className="num">{rupiah(orders.reduce((a, o) => a + Number(o.return_deduction || 0), 0))}</td>
                  <td className="num">{rupiah(orders.reduce((a, o) => a + Number(o.supplier_receivable || 0), 0))}</td>
                  <td className="num">{rupiah(orders.reduce((a, o) => a + Number(o.paid || 0), 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginTop: 8 }}><small>Hak supplier = product value dikurangi potongan retur/refund yang disetujui admin. Nilai hanya bertambah ke saldo setelah pesanan settled.</small></p>
      </Card>

      <Card title="Riwayat payout">
        {payouts.length === 0 ? <Empty>Belum ada payout.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>No. payout</th><th className="num">Jumlah</th><th>Status</th><th>Dibayar pada</th><th>Referensi bank</th><th className="num">Order</th></tr></thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.payout_no}</td>
                    <td className="num">{rupiah(p.amount)}</td>
                    <td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                    <td>{dt(p.paid_at)}</td>
                    <td><code>{p.bank_ref ?? '-'}</code></td>
                    <td className="num">{Array.isArray(p.order_ids) ? p.order_ids.length : '-'}</td>
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
