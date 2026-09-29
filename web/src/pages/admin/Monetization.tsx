import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupiah, num, pct, dt, d } from '../../lib/api';
import { Card, Stat, Badge, Alert, Empty, useAsync, BarChart } from '../../components/ui';
import { PageHead, HBar, SCOPE_LABEL, isoDate, daysAgo } from './shared';

function RankTable({ rows, labelKey, title, valueKey = 'platform_fee', secondKey, secondLabel }: { rows: any[]; labelKey: string; title: string; valueKey?: string; secondKey: string; secondLabel: string }) {
  if (!rows?.length) return <Card title={title}><Empty /></Card>;
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  return (
    <Card title={title}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{labelKey === 'category' ? 'Kategori' : labelKey === 'buyer' ? 'Buyer' : 'Supplier'}</th><th>Platform fee</th><th className="num">Nilai</th><th className="num">{secondLabel}</th><th className="num">Order</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r[labelKey]}</td>
                <td style={{ width: 160 }}><HBar value={Number(r[valueKey])} max={max} /></td>
                <td className="num">{rupiah(r[valueKey])}</td>
                <td className="num">{rupiah(r[secondKey])}</td>
                <td className="num">{num(r.orders)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Monetization() {
  const [from, setFrom] = useState(isoDate(daysAgo(30)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [applied, setApplied] = useState({ from: isoDate(daysAgo(30)), to: isoDate(new Date()) });
  const qs = new URLSearchParams();
  if (applied.from) qs.set('from', applied.from);
  if (applied.to) qs.set('to', applied.to + 'T23:59:59');
  const mon = useAsync(() => api.get(`/api/admin/monetization?${qs.toString()}`), [applied.from, applied.to]);

  const c = mon.data?.cards ?? {};
  const charts = mon.data?.charts ?? {};
  const fee = mon.data?.current_platform_fee;
  const rec = mon.data?.reconciliation;
  const byDay: any[] = (charts.gmv_by_day ?? []).map((r: any) => ({ ...r, label: d(r.day), gmv: Number(r.gmv), revenue: Number(r.revenue), platform_fee: Number(r.platform_fee) }));
  const takeRateTone = Number(c.average_take_rate_pct) >= Number(fee?.rate_percent ?? 0) * 0.9 ? 'good' : 'warn';

  return (
    <>
      <PageHead
        title="Finance → Monetization"
        desc="Ringkasan GMV, pendapatan platform, margin packaging/logistik, refund, dan hak supplier. Semua angka bersumber dari ledger double-entry."
        actions={
          <>
            {fee && <Badge>Platform fee aktif: {pct(fee.rate_percent)} · {SCOPE_LABEL[fee.scope_type] ?? fee.scope_type} · sejak {dt(fee.effective_from)}</Badge>}
            {rec && (
              <Link to="/admin/ledger"><Badge tone={rec.balanced ? 'good' : 'bad'}>{rec.balanced ? 'Rekonsiliasi seimbang' : `Variance ${rupiah(rec.variance)}`}</Badge></Link>
            )}
          </>
        }
      />

      <Card>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); setApplied({ from, to }); }}>
          <label className="field"><span className="field-label">Dari tanggal</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span className="field-label">Sampai tanggal</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <div className="form-actions">
            <button className="btn" type="submit">Terapkan</button>
            <button className="btn secondary" type="button" onClick={() => { setFrom(''); setTo(''); setApplied({ from: '', to: '' }); }}>Semua periode</button>
            <button className="btn secondary" type="button" onClick={() => { const f = isoDate(daysAgo(30)), t = isoDate(new Date()); setFrom(f); setTo(t); setApplied({ from: f, to: t }); }}>30 hari terakhir</button>
            <small className="muted">Kosongkan tanggal = seluruh periode. Grafik harian dibatasi 30 hari terakhir oleh server.</small>
          </div>
        </form>
      </Card>

      {mon.loading && <p>Memuat…</p>}
      {mon.error && <Alert kind="error">{mon.error}</Alert>}
      {mon.data && (
        <>
          <div className="stats">
            <Stat label="GMV" value={rupiah(c.gmv)} hint={`${num(c.paid_orders)} order dibayar`} />
            <Stat label="Product value" value={rupiah(c.product_value)} hint="Nilai produk (dasar take rate)" />
            <Stat label="Platform fee revenue" value={rupiah(c.platform_fee_revenue)} tone="good" hint="Neto setelah pembalikan refund" />
            <Stat label="Average take rate" value={pct(c.average_take_rate_pct)} tone={takeRateTone} hint={`Fee aktif ${pct(fee?.rate_percent)}`} />
            <Stat label="Packaging revenue" value={rupiah(c.packaging_revenue)} />
            <Stat label="Packaging profit" value={rupiah(c.packaging_profit)} tone={Number(c.packaging_profit) >= 0 ? 'good' : 'bad'} hint={`Biaya packaging ${rupiah(c.packaging_cost)}`} />
            <Stat label="Logistics revenue" value={rupiah(c.logistics_revenue)} hint={`Margin ${rupiah(c.logistics_margin)} · biaya ${rupiah(c.logistics_cost)}`} />
            <Stat label="Payment fees" value={rupiah(c.payment_fees_collected)} tone={Number(c.payment_fees_collected) >= Number(c.payment_processing_fee) ? undefined : 'warn'} hint={`Dipungut vs biaya provider ${rupiah(c.payment_processing_fee)}`} />
            <Stat label="Tax (PPN)" value={rupiah(c.tax)} tone="muted" hint="Utang pajak neto — bukan pendapatan" />
            <Stat label="Refunds" value={rupiah(c.refunds)} tone={Number(c.refunds) > 0 ? 'warn' : undefined} hint="Refund yang dibayarkan ke buyer" />
            <Stat label="Returns" value={num(c.return_cases)} tone={Number(c.return_cases) > 0 ? 'warn' : undefined} hint={`Kasus retur · biaya retur ${rupiah(c.return_cost)}`} />
            <Stat label="Supplier payable" value={rupiah(c.supplier_payable)} tone="muted" hint="Saldo hak supplier belum dibayar (semua periode)" />
            <Stat label="Net revenue" value={rupiah(c.net_revenue)} tone={Number(c.net_revenue) >= 0 ? 'good' : 'bad'} hint="Fee + margin packaging/logistik/pembayaran + layanan − diskon − biaya retur" />
            {Number(c.optional_service_revenue) !== 0 && <Stat label="Service revenue" value={rupiah(c.optional_service_revenue)} hint="Layanan opsional (asuransi, cold chain, handling)" />}
            {Number(c.promotion_discount) !== 0 && <Stat label="Promotion discount" value={rupiah(c.promotion_discount)} tone="warn" hint="Diskon promo ditanggung platform" />}
            {Number(c.logistics_recovery) !== 0 && <Stat label="Logistics recovery" value={rupiah(c.logistics_recovery)} hint="Klaim ke penyedia logistik" />}
          </div>

          <div className="grid cols-3">
            <Card title="GMV per hari"><BarChart data={byDay} valueKey="gmv" labelKey="label" format={(v) => rupiah(v)} /></Card>
            <Card title="Revenue per hari"><BarChart data={byDay} valueKey="revenue" labelKey="label" format={(v) => rupiah(v)} /></Card>
            <Card title="Platform fee revenue per hari"><BarChart data={byDay} valueKey="platform_fee" labelKey="label" format={(v) => rupiah(v)} /></Card>
          </div>

          <div className="grid cols-3">
            <Card title="Margin packaging">
              <table className="summary">
                <tbody>
                  <tr><td>Pendapatan</td><td>{rupiah(c.packaging_revenue)}</td></tr>
                  <tr><td>Biaya</td><td>−{rupiah(c.packaging_cost)}</td></tr>
                  <tr className="total"><td>Margin</td><td>{rupiah(c.packaging_profit)} ({Number(c.packaging_revenue) > 0 ? pct((Number(c.packaging_profit) / Number(c.packaging_revenue)) * 100) : '-'})</td></tr>
                </tbody>
              </table>
            </Card>
            <Card title="Margin logistik">
              <table className="summary">
                <tbody>
                  <tr><td>Pendapatan</td><td>{rupiah(c.logistics_revenue)}</td></tr>
                  <tr><td>Biaya</td><td>−{rupiah(c.logistics_cost)}</td></tr>
                  <tr><td>Recovery klaim</td><td>{rupiah(c.logistics_recovery)}</td></tr>
                  <tr className="total"><td>Margin</td><td>{rupiah(c.logistics_margin)} ({Number(c.logistics_revenue) > 0 ? pct((Number(c.logistics_margin) / Number(c.logistics_revenue)) * 100) : '-'})</td></tr>
                </tbody>
              </table>
            </Card>
            <Card title="Biaya retur">
              <table className="summary">
                <tbody>
                  <tr><td>Kasus retur</td><td>{num(c.return_cases)}</td></tr>
                  <tr><td>Refund ke buyer</td><td>{rupiah(c.refunds)}</td></tr>
                  <tr className="total"><td>Ditanggung platform</td><td>{rupiah(c.return_cost)}</td></tr>
                </tbody>
              </table>
            </Card>
          </div>

          <RankTable title="Revenue per kategori" rows={charts.revenue_by_category ?? []} labelKey="category" secondKey="gmv" secondLabel="GMV" />
          <div className="grid cols-2">
            <RankTable title="Revenue per buyer (top 10)" rows={charts.revenue_by_buyer ?? []} labelKey="buyer" secondKey="gmv" secondLabel="GMV" />
            <RankTable title="Revenue per supplier (top 10)" rows={charts.revenue_by_supplier ?? []} labelKey="supplier" secondKey="product_value" secondLabel="Product value" />
          </div>

          <div className="grid cols-2">
            <Card title="Platform fee saat ini">
              {fee ? (
                <dl className="kv">
                  <dt>Rate</dt><dd><b>{pct(fee.rate_percent)}</b></dd>
                  <dt>Scope</dt><dd>{SCOPE_LABEL[fee.scope_type] ?? fee.scope_type}{fee.scope_ref ? ` (${fee.scope_ref})` : ''}</dd>
                  <dt>Berlaku sejak</dt><dd>{dt(fee.effective_from)}</dd>
                  <dt>Berlaku sampai</dt><dd>{fee.effective_to ? dt(fee.effective_to) : 'tidak terbatas'}</dd>
                </dl>
              ) : <Empty>Belum ada konfigurasi fee.</Empty>}
              <p style={{ marginTop: 8 }}><Link to="/admin/fees">Ubah platform fee →</Link></p>
            </Card>
            <Card title="Rekonsiliasi ledger">
              {rec ? (
                <>
                  <p><Badge tone={rec.balanced ? 'good' : 'bad'}>{rec.balanced ? 'Seimbang (balanced)' : 'Tidak seimbang'}</Badge> {!rec.balanced && <span className="muted">variance {rupiah(rec.variance)}; jurnal tidak seimbang: {rec.unbalancedJournals?.length ?? 0}</span>}</p>
                  <dl className="kv">
                    <dt>Money in</dt><dd>{rupiah(rec.moneyIn)}</dd>
                    <dt>Money out</dt><dd>{rupiah(rec.moneyOut)}</dd>
                    <dt>Liabilitas</dt><dd>{rupiah(rec.liabilities)}</dd>
                    <dt>Pajak</dt><dd>{rupiah(rec.tax)}</dd>
                    <dt>Net revenue</dt><dd>{rupiah(rec.netRevenue)}</dd>
                  </dl>
                  <p style={{ marginTop: 8 }}><Link to="/admin/ledger">Lihat ledger &amp; rekonsiliasi →</Link></p>
                </>
              ) : <Empty />}
            </Card>
          </div>
        </>
      )}

      <p className="footer-note">Angka bersumber dari ledger double-entry; rekonsiliasi: Money In + Receivables = Money Out + Liability + Tax + Net Revenue. GMV dan product value dihitung dari order yang dibayar (paid_at) dalam rentang tanggal; supplier payable adalah saldo berjalan seluruh periode.</p>
    </>
  );
}
