import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, BATCH_STATUS_LABEL, d, num, rupiah } from '../../lib/api';
import { Alert, Badge, Card, Empty, Field, statusTone, useAsync } from '../../components/ui';
import { useDebounced } from './shared';

const HARVEST_STAGE_LABEL: Record<string, string> = { UPCOMING: 'Akan panen', PRE_HARVEST_UPDATED: 'Menjelang panen', FINAL: 'Panen final' };

export default function Market() {
  const [category, setCategory] = useState('');
  const [commodity, setCommodity] = useState('');
  const [region, setRegion] = useState('');
  const [status, setStatus] = useState('');
  const dCommodity = useDebounced(commodity);
  const dRegion = useDebounced(region);

  const cats = useAsync<any[]>(() => api.get('/api/categories'), []);
  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  if (dCommodity) qs.set('commodity', dCommodity);
  if (dRegion) qs.set('region', dRegion);
  if (status) qs.set('status', status);
  const listings = useAsync<any[]>(() => api.get(`/api/listings?${qs.toString()}`), [category, dCommodity, dRegion, status]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Listing batch yang sudah dideklarasikan supplier (Quality Self Declaration & Return Guarantee).</p>
        </div>
        <Link to="/buyer/rfqs" className="btn">Buat RFQ</Link>
      </div>

      <Card title="Filter">
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <Field label="Kategori">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Semua kategori</option>
              {(cats.data ?? []).map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Komoditas / nama produk"><input value={commodity} onChange={(e) => setCommodity(e.target.value)} placeholder="mis. Beras, Cabai" /></Field>
          <Field label="Wilayah supplier"><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="mis. Padang" /></Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Semua</option>
              <option value="READY_FOR_ORDER">Siap dipesan</option>
              <option value="UPCOMING">Akan panen</option>
            </select>
          </Field>
        </form>
      </Card>

      {listings.error && <Alert kind="error">{listings.error}</Alert>}
      {listings.loading && <p className="muted">Memuat listing…</p>}
      {!listings.loading && !listings.error && !(listings.data ?? []).length && (
        <Card><Empty>Tidak ada listing yang cocok. Anda dapat <Link to="/buyer/rfqs">membuat RFQ</Link> agar supplier mengirim penawaran.</Empty></Card>
      )}

      <div className="listing-grid">
        {(listings.data ?? []).map((l) => {
          const isHarvest = l.type === 'HARVEST' && l.status !== 'READY_FOR_ORDER';
          return (
            <Link key={l.id} to={`/buyer/listings/${l.id}`} className="listing">
              <div className="row between">
                <Badge tone={statusTone(l.status)}>{BATCH_STATUS_LABEL[l.status] ?? l.status}</Badge>
                <small className="muted">{l.photo_count} foto</small>
              </div>
              <h3 style={{ margin: '4px 0 0' }}>{l.product_name}</h3>
              <small className="muted">{l.commodity} · {l.category_name}{l.grade ? ` · Grade ${l.grade}` : ''}</small>
              <div className="price">{rupiah(l.price_per_unit)} <small className="muted">/ {l.unit}</small></div>
              <div>Tersedia: <b>{num(l.available_quantity, 3)} {l.unit}</b></div>
              {isHarvest && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {HARVEST_STAGE_LABEL[l.harvest_stage] ?? l.harvest_stage} · perkiraan panen {d(l.expected_harvest_date)}
                  {l.forecast_confidence != null && <> · keyakinan {num(l.forecast_confidence)}%</>}
                </div>
              )}
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 4 }}>
                <div><b>{l.supplier_name}</b>{l.supplier_verified && <Badge tone="good">Terverifikasi</Badge>}</div>
                <small className="muted">{l.supplier_region ?? '-'}</small>
                <div className="row" style={{ marginTop: 4 }}>
                  <Badge tone={l.supplier_quality_score == null ? '' : Number(l.supplier_quality_score) >= 80 ? 'good' : Number(l.supplier_quality_score) >= 60 ? 'warn' : 'bad'}>
                    Quality score {l.supplier_quality_score == null ? '-' : num(l.supplier_quality_score, 1)}
                  </Badge>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
