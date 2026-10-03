import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PublicLayout, ProductSkeleton, EmptyState, ErrorState } from '../../components/PublicLayout';
import { api, fileUrl, rupiah, num, errMsg, BATCH_STATUS_LABEL } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../components/ui';

export async function addToCart(nav: (p: string) => void, user: any, batchId: string, qty: number) {
  if (!user) { nav(`/login?next=/katalog/${batchId}`); return false; }
  if (user.role !== 'BUYER') { alert('Hanya akun pelanggan yang dapat berbelanja. Masuk dengan akun pelanggan.'); return false; }
  await api.post('/api/cart/items', { batch_id: batchId, quantity: qty });
  window.dispatchEvent(new Event('cart:changed'));
  return true;
}

export function ProductCard({ l }: { l: any }) {
  const nav = useNavigate(); const { user } = useAuth();
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const ready = l.status === 'READY_FOR_ORDER';
  return (
    <article className="product">
      <Link to={`/katalog/${l.id}`} className="img" aria-label={l.product_name}>{l.photo ? <img src={fileUrl(l.photo)} alt={l.product_name} loading="lazy" /> : <span>Tanpa foto</span>}</Link>
      <div className="body">
        <Link to={`/katalog/${l.id}`} className="name" style={{ color: 'var(--text)' }}>{l.product_name}{l.grade ? ` · Grade ${l.grade}` : ''}</Link>
        <div className="price">{rupiah(l.price_per_unit)} <small>/ {l.unit}</small></div>
        <div className="meta"><span>Min {num(l.min_order_qty ?? 1)} {l.unit}</span><span>· Tersedia {num(l.available_quantity)}</span></div>
        <div className="meta"><span>{l.supplier_region ?? '-'}</span>{l.supplier_quality_score != null && <span>· Skor {num(l.supplier_quality_score, 1)}</span>}{l.trade_model === 'RESELLER' && <span>· Supplier-ID</span>}</div>
        {!ready && <span className="badge warn">{BATCH_STATUS_LABEL[l.status] ?? l.status}</span>}
        {ready && <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); setMsg(''); try { if (await addToCart(nav, user, l.id, Number(l.min_order_qty ?? 1))) setMsg('Masuk keranjang ✓'); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); } }}>+ Keranjang</button>}
        {msg && <small className={msg.includes('✓') ? 'muted' : 'inline-error'}>{msg}</small>}
      </div>
    </article>
  );
}

export default function Catalog() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? ''; const category = sp.get('category') ?? ''; const region = sp.get('region') ?? ''; const sort = sp.get('sort') ?? 'rekomendasi';
  const cats = useAsync<any[]>(() => api.get('/api/categories'), []);
  const list = useAsync<any[]>(() => api.get(`/api/listings?${new URLSearchParams({ ...(category ? { category } : {}), ...(q ? { commodity: q } : {}), ...(region ? { region } : {}) })}`), [q, category, region]);
  const [page, setPage] = useState(1); const PAGE = 24;
  useEffect(() => setPage(1), [q, category, region, sort]);
  const rows = useMemo(() => {
    const r = [...(list.data ?? [])];
    if (sort === 'termurah') r.sort((a, b) => Number(a.price_per_unit) - Number(b.price_per_unit));
    if (sort === 'termahal') r.sort((a, b) => Number(b.price_per_unit) - Number(a.price_per_unit));
    if (sort === 'terbaru') r.sort((a, b) => new Date(b.published_at ?? 0).getTime() - new Date(a.published_at ?? 0).getTime());
    return r;
  }, [list.data, sort]);
  const regions = useMemo(() => Array.from(new Set((list.data ?? []).map((l) => l.supplier_region).filter(Boolean))), [list.data]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  return (
    <PublicLayout>
      <h1 style={{ marginBottom: 4 }}>Katalog{q ? ` · "${q}"` : ''}</h1>
      <p className="muted">Harga per satuan sudah termasuk model dagang kategori; biaya layanan, packaging, ongkir & pajak dirinci saat checkout.</p>
      <div className="chips" role="tablist" aria-label="Kategori">
        <button className={`chip ${!category ? 'active' : ''}`} onClick={() => set('category', '')}>Semua</button>
        {(cats.data ?? []).map((c) => <button key={c.code} className={`chip ${category === c.code ? 'active' : ''}`} onClick={() => set('category', c.code)}>{c.name}</button>)}
      </div>
      <div className="toolbar">
        <select aria-label="Wilayah" value={region} onChange={(e) => set('region', e.target.value)}><option value="">Semua wilayah</option>{regions.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        <select aria-label="Urutkan" value={sort} onChange={(e) => set('sort', e.target.value)}><option value="rekomendasi">Rekomendasi</option><option value="termurah">Harga terendah</option><option value="termahal">Harga tertinggi</option><option value="terbaru">Terbaru</option></select>
        {list.data && <small className="muted">{rows.length} produk</small>}
      </div>
      {list.loading && !list.data && <ProductSkeleton />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && (rows.length ? (
        <>
          <div className="product-grid">{rows.slice(0, page * PAGE).map((l) => <ProductCard key={l.id} l={l} />)}</div>
          {rows.length > page * PAGE && <div className="pager"><button className="btn secondary" onClick={() => setPage(page + 1)}>Muat lebih banyak</button></div>}
        </>
      ) : <EmptyState title="Tidak ada produk yang cocok">Coba kata kunci atau kategori lain.</EmptyState>)}
    </PublicLayout>
  );
}
