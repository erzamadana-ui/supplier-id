import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, attributeRows, BATCH_STATUS_LABEL, d, dt, errMsg, num, pct, rupiah } from '../../lib/api';
import { Alert, AsyncButton, Badge, Card, EvidenceGallery, Field, statusTone, useAsync } from '../../components/ui';
import { AttrField, fmtVal, KV, OPTIONAL_SERVICES, SummaryTable, useDebounced } from './shared';
import { useAsync as useAsyncSvc } from '../../components/ui';

const HARVEST_STAGE_LABEL: Record<string, string> = { UPCOMING: 'Akan panen', PRE_HARVEST_UPDATED: 'Menjelang panen (update)', FINAL: 'Panen final' };

export default function Listing() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: l, error, loading } = useAsync<any>(() => api.get(`/api/listings/${id}`), [id]);

  // ---- panel pesanan ----
  const [quantity, setQuantity] = useState('');
  const [distanceKm, setDistanceKm] = useState('0');
  const [address, setAddress] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const svc = useAsyncSvc(() => api.get('/api/optional-services'));
  const [promo, setPromo] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  const debKey = useDebounced(JSON.stringify({ quantity, distanceKm, services, promo }), 450);

  useEffect(() => {
    if (!l || l.status !== 'READY_FOR_ORDER') return;
    const qty = Number(quantity);
    if (!(qty > 0)) { setPreview(null); setPreviewErr(''); return; }
    let cancelled = false;
    setPreviewBusy(true); setPreviewErr('');
    api.post('/api/orders/preview', { batch_id: l.id, quantity: qty, distance_km: Number(distanceKm) || 0, optional_service_codes: services, promo_code: promo || undefined })
      .then((r) => { if (!cancelled) setPreview(r); })
      .catch((e) => { if (!cancelled) { setPreview(null); setPreviewErr(errMsg(e)); } })
      .finally(() => { if (!cancelled) setPreviewBusy(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [debKey, l?.id, l?.status]);

  if (loading && !l) return <p className="muted">Memuat listing…</p>;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!l) return null;

  const schema: AttrField[] = l.attribute_schema ?? [];
  const attrs: Record<string, any> = l.attributes ?? {};
  const declPhotos = (l.photos ?? []).filter((p: any) => p.owner_type === 'BATCH');
  const harvestPhotos = (l.photos ?? []).filter((p: any) => String(p.owner_type).startsWith('HARVEST'));
  const qs = l.supplier_quality;
  const qty = Number(quantity);
  const qtyTooMuch = qty > Number(l.available_quantity);
  const canOrder = l.status === 'READY_FOR_ORDER';
  const promoIgnored = preview && promo && !preview.discountLine;

  const declaredRows: [string, any][] = [
    ['Batch', l.batch_code], ['Tipe', l.type === 'HARVEST' ? 'Hasil panen' : 'Ready stock'], ['Grade', l.grade],
    ['Kuantitas deklarasi', `${num(l.quantity, 3)} ${l.unit}`], ['Tersedia', `${num(l.available_quantity, 3)} ${l.unit}`],
    ['Berat diharapkan (kg)', fmtVal(l.expected_weight_kg)], ['Toleransi berat', pct(l.weight_tolerance_pct)],
    ['Tanggal panen', d(l.harvest_date)], ['Tanggal tersedia', d(l.availability_date)],
    ['Kondisi', l.condition], ['Ukuran', l.size], ['Warna', l.color], ['Kesegaran', l.freshness], ['Kelembapan', l.moisture],
    ['Suhu (°C)', fmtVal(l.temperature_c)], ['Umur simpan (hari)', fmtVal(l.shelf_life_days)], ['Tanggal kedaluwarsa', d(l.expiry_date)],
    ...attributeRows(schema, attrs, fmtVal),
  ];
  const productRows: [string, any][] = [
    ['Komoditas', l.commodity], ['Kategori', l.category_name], ['Varietas', l.variety], ['Asal', l.origin],
    ['Metode produksi', l.production_method], ['Sertifikasi', l.certification],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <small className="muted"><Link to="/buyer">Marketplace</Link> / {l.batch_code}</small>
          <h1>{l.product_name} <Badge tone={statusTone(l.status)}>{BATCH_STATUS_LABEL[l.status] ?? l.status}</Badge></h1>
          <p>{l.supplier_name} · {l.supplier_region ?? '-'} · Quality score <b>{qs?.score == null ? '-' : num(qs.score, 1)}</b></p>
        </div>
        <div className="price">{rupiah(l.price_per_unit)} <small className="muted">/ {l.unit}</small></div>
      </div>

      <div className="grid cols-2">
        <div>
          <Card title="Produk">
            <KV rows={productRows} />
          </Card>
          <Card title="Deklarasi batch (Quality Self Declaration)">
            <KV rows={declaredRows} />
            {l.declaration ? (
              <Alert kind="success">
                Supplier telah menyetujui <b>Quality Self Declaration &amp; Return Guarantee</b> versi {l.declaration.declaration_version} pada {dt(l.declaration.accepted_at)}.
              </Alert>
            ) : (
              <Alert kind="warn">Belum ada catatan persetujuan deklarasi untuk batch ini.</Alert>
            )}
          </Card>
          {l.harvest && (
            <Card title={`Informasi panen — ${HARVEST_STAGE_LABEL[l.harvest.stage] ?? l.harvest.stage}`}>
              <div className="grid cols-2">
                <div>
                  <h4 className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>PERKIRAAN</h4>
                  <KV rows={[
                    ['Tanggal tanam', d(l.harvest.planting_date)], ['Perkiraan panen', d(l.harvest.expected_harvest_date)],
                    ['Perkiraan kuantitas', `${num(l.harvest.expected_quantity, 3)} ${l.unit}`], ['Perkiraan grade', l.harvest.expected_grade],
                    ['Perkiraan kualitas', l.harvest.expected_quality], ['Kondisi saat ini', l.harvest.current_condition],
                    ['Keyakinan forecast', l.harvest.forecast_confidence != null ? `${l.harvest.forecast_confidence}%` : '-'],
                    ['Catatan pre-harvest', l.harvest.pre_harvest_note], ['Update pre-harvest', dt(l.harvest.pre_harvest_updated_at)],
                  ]} />
                </div>
                <div>
                  <h4 className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>AKTUAL</h4>
                  {l.harvest.finalized_at ? (
                    <KV rows={[
                      ['Tanggal panen aktual', d(l.harvest.actual_harvest_date)], ['Kuantitas aktual', `${num(l.harvest.actual_quantity, 3)} ${l.unit}`],
                      ['Grade aktual', l.harvest.actual_grade], ['Berat aktual (kg)', fmtVal(l.harvest.actual_weight_kg)],
                      ['Kondisi aktual', l.harvest.actual_condition], ['Difinalkan', dt(l.harvest.finalized_at)],
                    ]} />
                  ) : <p className="muted">Belum ada deklarasi panen final.</p>}
                </div>
              </div>
            </Card>
          )}
          <Card title={`Foto deklarasi supplier (${declPhotos.length})`}>
            <EvidenceGallery files={declPhotos} emptyText="Tidak ada foto deklarasi." />
          </Card>
          {harvestPhotos.length > 0 && (
            <Card title={`Foto kondisi panen (${harvestPhotos.length})`}>
              <EvidenceGallery files={harvestPhotos} />
            </Card>
          )}
          {qs && (
            <Card title="Supplier quality score">
              <div className="stats">
                <div className="stat"><div className="stat-label">Skor</div><div className="stat-value">{num(qs.score, 1)}</div><div className="stat-hint">dihitung {dt(qs.computed_at)}</div></div>
                <div className="stat"><div className="stat-label">Total order</div><div className="stat-value">{num(qs.metrics?.total_orders)}</div></div>
                <div className="stat"><div className="stat-label">Tingkat retur</div><div className="stat-value">{pct(qs.metrics?.return_rate)}</div></div>
                <div className="stat"><div className="stat-label">Tingkat dispute</div><div className="stat-value">{pct(qs.metrics?.dispute_rate)}</div></div>
              </div>
            </Card>
          )}
        </div>

        <div>
          {canOrder ? (
            <Card title="Pesan langsung">
              <form className="inline" onSubmit={(e) => e.preventDefault()}>
                <Field label={`Kuantitas (${l.unit})`} required hint={`Maksimal ${num(l.available_quantity, 3)} ${l.unit}`}>
                  <input type="number" min={0} step="any" max={l.available_quantity} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </Field>
                <Field label="Jarak pengiriman (km)" required hint="Dipakai menghitung biaya delivery">
                  <input type="number" min={0} step="any" value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} />
                </Field>
                <Field label="Kode promo (opsional)">
                  <input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="mis. PROMO10" />
                </Field>
                <Field label="Alamat pengiriman">
                  <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Alamat gudang / penerima" />
                </Field>
              </form>
              <div style={{ margin: '10px 0' }}>
                <div className="field-label" style={{ marginBottom: 4 }}>Layanan opsional</div>
                <ul className="checklist">
                  {(svc.data?.length ? svc.data : OPTIONAL_SERVICES).map((s: any) => (
                    <li key={s.code}>
                      <label className="row">
                        <input type="checkbox" checked={services.includes(s.code)} onChange={(e) => setServices((cur) => (e.target.checked ? [...cur, s.code] : cur.filter((c) => c !== s.code)))} />
                        {s.label}
                      </label>
                    </li>
                  ))}
                </ul>
                <small className="muted">Harga layanan opsional mengikuti konfigurasi platform dan tampil di ringkasan.</small>
              </div>
              {qtyTooMuch && <Alert kind="error">Kuantitas melebihi stok tersedia ({num(l.available_quantity, 3)} {l.unit}).</Alert>}
              {previewErr && <Alert kind="error">{previewErr}</Alert>}
              {promoIgnored && <Alert kind="warn">Kode promo <b>{promo}</b> tidak dikenali atau tidak aktif — diskon tidak diterapkan.</Alert>}

              <h3 style={{ marginTop: 12 }}>Order Summary {previewBusy && <small className="muted">(menghitung…)</small>}</h3>
              {preview ? (
                <SummaryTable m={{ ...preview, quantity: qty, unit: l.unit, unitPrice: Number(l.price_per_unit) }} />
              ) : (
                <p className="muted">Masukkan kuantitas untuk melihat rincian biaya.</p>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <AsyncButton
                  disabled={!preview || !(qty > 0) || qtyTooMuch || previewBusy}
                  onClick={async () => {
                    const o = await api.post('/api/orders', {
                      batch_id: l.id, quantity: qty, distance_km: Number(distanceKm) || 0, optional_service_codes: services,
                      promo_code: promo || undefined, delivery_address: address || undefined,
                    });
                    nav(`/orders/${o.id}`);
                  }}
                >
                  Buat pesanan
                </AsyncButton>
                <small className="muted">Pesanan dibuat sebagai DRAFT; harga dikunci saat Anda mengonfirmasi.</small>
              </div>
            </Card>
          ) : (
            <Card title="Pemesanan">
              <Alert kind="warn">Belum bisa dipesan — menunggu deklarasi panen final dari supplier.</Alert>
              <p>Anda dapat mengajukan RFQ untuk batch ini agar supplier mengirim penawaran (harga &amp; kuantitas) begitu panen siap.</p>
              <Link className="btn" to={`/buyer/rfqs?batch_id=${l.id}&commodity=${encodeURIComponent(l.commodity ?? '')}&category_id=${l.category_id ?? ''}&unit=${encodeURIComponent(l.unit ?? 'KG')}`}>Buat RFQ untuk batch ini</Link>
            </Card>
          )}
          <Card title="Jaminan retur">
            <p>Supplier menjamin kesesuaian barang dengan deklarasi di atas. Saat barang tiba, lakukan inspeksi dan unggah <b>foto + video</b> kondisi barang sebelum digunakan/diproses jika ada ketidaksesuaian.</p>
            <small className="muted">Klaim retur dievaluasi Admin berdasarkan perbandingan bukti deklarasi supplier, data pengiriman, dan bukti penerimaan buyer.</small>
          </Card>
        </div>
      </div>
    </>
  );
}
