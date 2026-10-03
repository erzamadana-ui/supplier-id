import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PublicLayout, ErrorState } from '../../components/PublicLayout';
import { api, attributeRows, BATCH_STATUS_LABEL, d, dt, errMsg, num, pct, rupiah } from '../../lib/api';
import { Alert, Badge, Card, EvidenceGallery, statusTone, useAsync } from '../../components/ui';
import { AttrField, fmtVal, KV } from '../buyer/shared';
import { useAuth } from '../../lib/auth';
import { addToCart } from './Catalog';

const HARVEST_STAGE_LABEL: Record<string, string> = { UPCOMING: 'Akan panen', PRE_HARVEST_UPDATED: 'Menjelang panen (update)', FINAL: 'Panen final' };

export default function Product() {
  const { id } = useParams(); const nav = useNavigate(); const { user } = useAuth();
  const { data: l, error, loading, reload } = useAsync<any>(() => api.get(`/api/listings/${id}`), [id]);
  const [qty, setQty] = useState<string>('');
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  if (loading && !l) return <PublicLayout><div className="grid cols-2"><div className="skeleton" style={{ minHeight: 320 }} /><div className="skeleton" style={{ minHeight: 320 }} /></div></PublicLayout>;
  if (error) return <PublicLayout><ErrorState message={error} onRetry={reload} /></PublicLayout>;
  if (!l) return null;
  const schema: AttrField[] = l.attribute_schema ?? [];
  const minQ = Number(l.min_order_qty ?? 1); const q = Number(qty || minQ);
  const ready = l.status === 'READY_FOR_ORDER';
  const photos = (l.photos ?? []).filter((p: any) => p.owner_type === 'BATCH');
  const add = async (go: boolean) => {
    setMsg(''); setBusy(true);
    try {
      if (q < minQ) throw new Error(`Minimum pesan ${num(minQ)} ${l.unit}`);
      if (q > Number(l.available_quantity)) throw new Error(`Tersedia hanya ${num(l.available_quantity)} ${l.unit}`);
      if (await addToCart(nav, user, l.id, q)) { setMsg('Masuk keranjang ✓'); if (go) nav('/keranjang'); }
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <PublicLayout>
      <small className="muted"><Link to="/katalog">Katalog</Link> / <Link to={`/katalog?category=${l.category_code}`}>{l.category_name}</Link> / {l.batch_code}</small>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <div>
          <Card><EvidenceGallery files={photos} emptyText="Mitra belum mengunggah foto." /></Card>
          <Card title="Deklarasi batch (diisi mitra, terkunci saat publikasi)">
            <KV rows={[
              ['Batch', l.batch_code], ['Tipe', l.type === 'HARVEST' ? 'Hasil panen' : 'Ready stock'], ['Grade', l.grade], ['Kuantitas tersedia', `${num(l.available_quantity, 3)} ${l.unit}`],
              ['Berat per satuan (est.)', l.expected_weight_kg && Number(l.quantity) > 0 ? `${num(Number(l.expected_weight_kg) / Number(l.quantity), 3)} kg` : '-'], ['Toleransi berat', pct(l.weight_tolerance_pct)],
              ['Tanggal panen', d(l.harvest_date)], ['Tersedia sejak', d(l.availability_date)], ['Kondisi', l.condition], ['Ukuran', l.size], ['Warna', l.color], ['Kesegaran', l.freshness],
              ['Suhu simpan (°C)', fmtVal(l.temperature_c)], ['Umur simpan', l.shelf_life_days ? `${l.shelf_life_days} hari` : l.shelf_life_days_default ? `±${l.shelf_life_days_default} hari (kategori)` : '-'], ['Kedaluwarsa', d(l.expiry_date)],
              ['Penyimpanan', l.storage_instructions ?? l.category_storage ?? '-'],
              ...attributeRows(schema, l.attributes, fmtVal),
            ]} />
            {l.declaration ? <Alert kind="success">Mitra menyetujui <b>Quality Self Declaration &amp; Return Guarantee</b> v{l.declaration.declaration_version} pada {dt(l.declaration.accepted_at)}.</Alert> : <Alert kind="warn">Belum ada persetujuan deklarasi untuk batch ini.</Alert>}
          </Card>
          {l.harvest && <Card title={`Informasi panen — ${HARVEST_STAGE_LABEL[l.harvest.stage] ?? l.harvest.stage}`}><KV rows={[['Perkiraan panen', d(l.harvest.expected_harvest_date)], ['Perkiraan kuantitas', `${num(l.harvest.expected_quantity, 3)} ${l.unit}`], ['Kondisi saat ini', l.harvest.current_condition], ['Keyakinan', l.harvest.forecast_confidence != null ? `${l.harvest.forecast_confidence}%` : '-']]} /></Card>}
        </div>
        <div>
          <Card>
            <h1 style={{ fontSize: 24 }}>{l.product_name} <Badge tone={statusTone(l.status)}>{BATCH_STATUS_LABEL[l.status] ?? l.status}</Badge></h1>
            <p className="muted">{l.trade_model === 'RESELLER' ? 'Dijual oleh Supplier-ID' : l.supplier_name} · {l.supplier_region ?? '-'} {l.supplier_quality?.score != null && <>· Skor kualitas mitra <b>{num(l.supplier_quality.score, 1)}</b></>}</p>
            <div className="price" style={{ fontSize: 28, fontWeight: 800, color: 'var(--brand)' }}>{rupiah(l.price_per_unit)} <small className="muted" style={{ fontSize: 14, fontWeight: 500 }}>/ {l.unit}</small></div>
            <p className="muted" style={{ marginTop: 4 }}>Minimum pesan {num(minQ)} {l.unit} · Biaya layanan, packaging, ongkir & pajak dirinci transparan di checkout.</p>
            {ready ? (
              <>
                <label className="field"><span className="field-label">Kuantitas ({l.unit})</span><input type="number" inputMode="decimal" min={minQ} step="0.5" value={qty} placeholder={String(minQ)} onChange={(e) => setQty(e.target.value)} /></label>
                <div className="row">
                  <button className="btn lg" disabled={busy} onClick={() => add(true)}>Beli sekarang</button>
                  <button className="btn lg secondary" disabled={busy} onClick={() => add(false)}>+ Keranjang</button>
                </div>
                {msg && <p className={msg.includes('✓') ? 'muted' : 'inline-error'} style={{ marginTop: 8 }}>{msg}</p>}
              </>
            ) : <Alert kind="warn">Batch ini belum dapat dipesan ({BATCH_STATUS_LABEL[l.status] ?? l.status}).</Alert>}
          </Card>
          <Card title="Jaminan & cara terima">
            <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
              <li>Berat aktual ditimbang saat QC; selisih di luar toleransi {pct(l.weight_tolerance_pct)} memerlukan persetujuan Anda.</li>
              <li>Kurir meminta kode OTP dari aplikasi Anda saat serah terima.</li>
              <li>Periksa barang dan konfirmasi dalam 24 jam; klaim wajib foto + video.</li>
            </ul>
          </Card>
          {l.supplier_quality && (
            <Card title="Rekam jejak mitra">
              <div className="stats">
                <div className="stat"><div className="stat-label">Skor</div><div className="stat-value">{num(l.supplier_quality.score, 1)}</div></div>
                <div className="stat"><div className="stat-label">Order</div><div className="stat-value">{num(l.supplier_quality.metrics?.total_orders)}</div></div>
                <div className="stat"><div className="stat-label">Tingkat retur</div><div className="stat-value">{pct(l.supplier_quality.metrics?.return_rate)}</div></div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </PublicLayout>
  );
}
