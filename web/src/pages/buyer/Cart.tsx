import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PublicLayout, EmptyState, ErrorState } from '../../components/PublicLayout';
import { api, fileUrl, rupiah, num, errMsg, dt } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, Alert, Field, useAsync } from '../../components/ui';

export default function Cart() {
  const { user } = useAuth(); const nav = useNavigate();
  const cart = useAsync<any>(() => (user?.role === 'BUYER' ? api.get('/api/cart') : Promise.resolve({ items: [], subtotal: 0 })), [user?.id]);
  const [err, setErr] = useState('');
  const setQty = async (batchId: string, q: number) => { setErr(''); try { await api.post('/api/cart/items', { batch_id: batchId, quantity: q }); await cart.reload(); window.dispatchEvent(new Event('cart:changed')); } catch (e) { setErr(errMsg(e)); } };
  const remove = async (batchId: string) => { await api.delete(`/api/cart/items/${batchId}`); await cart.reload(); window.dispatchEvent(new Event('cart:changed')); };
  if (!user) return <PublicLayout><EmptyState title="Masuk untuk melihat keranjang"><Link to="/login?next=/keranjang" className="btn">Masuk</Link> <Link to="/register" className="btn secondary">Daftar</Link></EmptyState></PublicLayout>;
  if (user.role !== 'BUYER') return <PublicLayout><EmptyState title="Keranjang hanya untuk akun pelanggan" /></PublicLayout>;
  const items = cart.data?.items ?? [];
  const bySupplier: Record<string, any[]> = {};
  for (const it of items) (bySupplier[it.supplier_name] ??= []).push(it);
  return (
    <PublicLayout searchable={false}>
      <h1>Keranjang</h1>
      {err && <Alert kind="error">{err}</Alert>}
      {cart.error && <ErrorState message={cart.error} onRetry={cart.reload} />}
      {cart.loading && !cart.data && <div className="skeleton" style={{ minHeight: 120 }} />}
      {cart.data && !items.length && <EmptyState title="Keranjang kosong"><Link to="/katalog" className="btn">Mulai belanja</Link></EmptyState>}
      {items.length > 0 && (
        <div className="grid cols-2 wide-left">
          <div>
            {Object.entries(bySupplier).map(([sup, rows]) => (
              <Card key={sup} title={rows[0].trade_model === 'RESELLER' ? 'Dijual oleh Supplier-ID' : `Mitra: ${sup}`}>
                {rows.map((it) => (
                  <div key={it.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <div className="row" style={{ flex: 1 }}>
                      <div style={{ width: 56, height: 56, borderRadius: 10, background: 'var(--bg-2)', overflow: 'hidden', flexShrink: 0 }}>{it.photo && <img src={fileUrl(it.photo)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}</div>
                      <div>
                        <Link to={`/katalog/${it.batch_id}`} style={{ color: 'var(--text)', fontWeight: 600 }}>{it.product_name}</Link><br />
                        <small className="muted">{rupiah(it.unit_price)} / {it.unit} · min {num(it.min_order_qty)} · tersedia {num(it.available_quantity)}</small>
                        {!it.available && <div><span className="badge bad">Stok tidak mencukupi / tidak tersedia</span></div>}
                      </div>
                    </div>
                    <div className="row">
                      <button className="btn small secondary" aria-label="Kurangi" onClick={() => setQty(it.batch_id, Math.max(Number(it.min_order_qty), Number(it.quantity) - 1))}>−</button>
                      <input type="number" inputMode="decimal" value={it.quantity} min={it.min_order_qty} step="0.5" style={{ width: 80 }} aria-label="Kuantitas" onChange={(e) => setQty(it.batch_id, Number(e.target.value))} />
                      <button className="btn small secondary" aria-label="Tambah" onClick={() => setQty(it.batch_id, Number(it.quantity) + 1)}>+</button>
                      <b style={{ minWidth: 90, textAlign: 'right' }}>{rupiah(it.line_total)}</b>
                      <button className="btn small secondary" onClick={() => remove(it.batch_id)} aria-label="Hapus">✕</button>
                    </div>
                  </div>
                ))}
              </Card>
            ))}
          </div>
          <div>
            <Card title="Ringkasan">
              <div className="row between"><span>Subtotal produk</span><b>{rupiah(cart.data.subtotal)}</b></div>
              <p className="muted" style={{ marginTop: 6 }}><small>Biaya layanan, packaging, ongkir, pajak dan promo dihitung di langkah berikutnya per mitra (pengiriman terpisah per mitra).</small></p>
              <button className="btn lg block" disabled={items.some((i: any) => !i.available)} onClick={() => nav('/checkout')}>Lanjut ke checkout</button>
            </Card>
          </div>
        </div>
      )}
    </PublicLayout>
  );
}

/** Checkout ringkas: alamat → rincian per suborder → persetujuan kebijakan → buat order induk → bayar. */
export function Checkout() {
  const { user } = useAuth(); const nav = useNavigate();
  const addrs = useAsync<any[]>(() => api.get('/api/me/addresses'), []);
  const cartQ = useAsync<any>(() => api.get('/api/cart'), []);
  const svc = useAsync<any[]>(() => api.get('/api/optional-services').catch(() => []), []);
  const [addressId, setAddressId] = useState('');
  const [newAddr, setNewAddr] = useState<any>({ label: 'Rumah', recipient: user?.name ?? '', phone: '', address: '', city: '', province: '', distance_km: '' });
  const [showNew, setShowNew] = useState(false);
  const [services, setServices] = useState<string[]>([]); const [promo, setPromo] = useState('');
  const [acceptPolicy, setAcceptPolicy] = useState(false); const [acceptWeight, setAcceptWeight] = useState(false);
  const [preview, setPreview] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (addrs.data?.length && !addressId) setAddressId(addrs.data.find((a) => a.is_default)?.id ?? addrs.data[0].id); }, [addrs.data]);
  useEffect(() => {
    if (!addressId || !cartQ.data?.items?.length) return;
    let c = false; setErr('');
    api.post('/api/checkout/preview', { address_id: addressId, optional_service_codes: services, promo_code: promo || undefined }).then((p) => { if (!c) setPreview(p); }).catch((e) => { if (!c) setErr(errMsg(e)); });
    return () => { c = true; };
  }, [addressId, services, promo, cartQ.data]);
  const saveAddr = async () => { setErr(''); try { const a = await api.post('/api/me/addresses', { ...newAddr, distance_km: Number(newAddr.distance_km) || 0 }); await addrs.reload(); setAddressId(a.id); setShowNew(false); } catch (e) { setErr(errMsg(e)); } };
  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post('/api/checkout', { address_id: addressId, optional_service_codes: services, promo_code: promo || undefined, accept_auto_confirm_policy: acceptPolicy, accept_weight_tolerance: acceptWeight });
      window.dispatchEvent(new Event('cart:changed'));
      nav(`/pesanan/${r.group.id}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (!user || user.role !== 'BUYER') return <PublicLayout><EmptyState title="Masuk sebagai pelanggan untuk checkout"><Link to="/login?next=/checkout" className="btn">Masuk</Link></EmptyState></PublicLayout>;
  if (cartQ.data && !cartQ.data.items.length) return <PublicLayout searchable={false}><EmptyState title="Keranjang kosong"><Link to="/katalog" className="btn">Mulai belanja</Link></EmptyState></PublicLayout>;
  return (
    <PublicLayout searchable={false}>
      <h1>Checkout</h1>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="grid cols-2 wide-left">
        <div>
          <Card title="1. Alamat pengiriman" actions={<button className="btn small secondary" onClick={() => setShowNew(!showNew)}>{showNew ? 'Batal' : '+ Alamat baru'}</button>}>
            {addrs.data?.map((a) => (
              <label key={a.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
                <input type="radio" name="addr" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                <div><b>{a.label}</b> — {a.recipient} ({a.phone})<br /><small className="muted">{a.address}{a.city ? ', ' + a.city : ''}{a.province ? ', ' + a.province : ''} · jarak ke hub {num(a.distance_km)} km</small></div>
              </label>
            ))}
            {addrs.data && !addrs.data.length && !showNew && <p className="muted">Belum ada alamat. Tambahkan alamat untuk melanjutkan.</p>}
            {showNew && (
              <div className="grid cols-2" style={{ marginTop: 10 }}>
                <Field label="Label"><input value={newAddr.label} onChange={(e) => setNewAddr({ ...newAddr, label: e.target.value })} /></Field>
                <Field label="Nama penerima" required><input value={newAddr.recipient} onChange={(e) => setNewAddr({ ...newAddr, recipient: e.target.value })} /></Field>
                <Field label="Telepon penerima" required><input inputMode="tel" value={newAddr.phone} onChange={(e) => setNewAddr({ ...newAddr, phone: e.target.value })} /></Field>
                <Field label="Jarak ke hub Supplier-ID (km)" hint="Sementara diisi manual; dipakai menghitung ongkir [belum ada geocoding]"><input type="number" inputMode="decimal" value={newAddr.distance_km} onChange={(e) => setNewAddr({ ...newAddr, distance_km: e.target.value })} /></Field>
                <div style={{ gridColumn: '1 / -1' }}><Field label="Alamat lengkap" required><textarea rows={2} style={{ fontFamily: 'inherit' }} value={newAddr.address} onChange={(e) => setNewAddr({ ...newAddr, address: e.target.value })} /></Field></div>
                <Field label="Kota/Kabupaten"><input value={newAddr.city} onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} /></Field>
                <Field label="Provinsi"><input value={newAddr.province} onChange={(e) => setNewAddr({ ...newAddr, province: e.target.value })} /></Field>
                <div><button className="btn" onClick={saveAddr}>Simpan alamat</button></div>
              </div>
            )}
          </Card>
          <Card title="2. Layanan opsional & promo">
            {(svc.data ?? []).map((s: any) => <label key={s.code} className="row" style={{ padding: '4px 0' }}><input type="checkbox" checked={services.includes(s.code)} onChange={(e) => setServices(e.target.checked ? [...services, s.code] : services.filter((x) => x !== s.code))} /> {s.label}</label>)}
            <Field label="Kode promo (opsional)"><input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="mis. HEMAT5" /></Field>
          </Card>
          <Card title="3. Persetujuan">
            <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={acceptPolicy} onChange={(e) => setAcceptPolicy(e.target.checked)} /><span>Saya memahami <b>kebijakan konfirmasi {preview?.confirmation_window_hours ?? 24} jam</b>: setelah bukti penerimaan sah (OTP), saya memeriksa barang dan mengonfirmasi/mengajukan klaim dalam {preview?.confirmation_window_hours ?? 24} jam; tanpa respons, pesanan dianggap sesuai dan pembayaran mitra diproses.</span></label>
            <label className="row" style={{ alignItems: 'flex-start', marginTop: 8 }}><input type="checkbox" checked={acceptWeight} onChange={(e) => setAcceptWeight(e.target.checked)} /><span>Saya menyetujui <b>toleransi berat aktual</b> per batch (umumnya 2%). Kekurangan di luar toleransi dikembalikan; kelebihan di luar toleransi akan meminta persetujuan saya terlebih dahulu.</span></label>
          </Card>
        </div>
        <div>
          <Card title="Ringkasan pembayaran">
            {!preview && !err && <div className="skeleton" style={{ minHeight: 80 }} />}
            {preview && (
              <>
                {preview.lines.map((l: any, i: number) => (
                  <div key={i} style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
                    <div className="row between"><b>Pesanan {i + 1} · {num(l.quantity)} {l.unit}</b><span>{rupiah(l.total_amount)}</span></div>
                    <div className="row between muted"><small>Produk {rupiah(l.product_value)} · Layanan {rupiah(l.platform_fee_amount)} · Packaging {rupiah(l.packaging_amount)} · Ongkir {rupiah(l.logistics_amount)} · Biaya bayar {rupiah(l.payment_fee_amount)} · Pajak {rupiah(l.tax_amount)}{Number(l.discount_amount) > 0 ? ` · Diskon −${rupiah(l.discount_amount)}` : ''}</small></div>
                  </div>
                ))}
                <div className="row between" style={{ fontSize: 18, marginTop: 8 }}><b>Total bayar</b><b>{rupiah(preview.total_amount)}</b></div>
                <p className="muted"><small>Tidak ada biaya tersembunyi. Bayar dalam {preview.payment_expiry_hours} jam setelah checkout; lewat itu reservasi stok dilepas.</small></p>
                <button className="btn lg block" disabled={busy || !addressId || !acceptPolicy || !acceptWeight} onClick={submit}>{busy ? '…' : 'Buat pesanan & lanjut bayar'}</button>
              </>
            )}
          </Card>
        </div>
      </div>
    </PublicLayout>
  );
}

/** Order induk: status bayar, daftar suborder, tombol bayar (sandbox). */
export function OrderGroup() {
  const { id } = useParams(); const nav = useNavigate();
  const g = useAsync<any>(() => api.get(`/api/order-groups/${id}`), [id]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const pay = async () => { setErr(''); setBusy(true); try { await api.post(`/api/order-groups/${id}/pay`, { channel: 'VA' }); await g.reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const d = g.data;
  return (
    <PublicLayout searchable={false}>
      {g.loading && !d && <div className="skeleton" style={{ minHeight: 160 }} />}
      {g.error && <ErrorState message={g.error} onRetry={g.reload} />}
      {d && (
        <>
          <h1>Pesanan {d.group_no} <span className={`badge ${d.status === 'PAID' ? 'good' : d.status === 'PENDING_PAYMENT' ? 'warn' : 'bad'}`}>{{ PENDING_PAYMENT: 'Menunggu pembayaran', PAID: 'Dibayar', EXPIRED: 'Kedaluwarsa', CANCELLED: 'Dibatalkan', COMPLETED: 'Selesai' }[d.status as string] ?? d.status}</span></h1>
          <p className="muted">Dibuat {dt(d.created_at)} · Kirim ke: {d.delivery_address}</p>
          {err && <Alert kind="error">{err}</Alert>}
          {d.status === 'PENDING_PAYMENT' && (
            <Card title="Pembayaran">
              <div className="row between"><div><div className="muted">Total</div><div style={{ fontSize: 24, fontWeight: 800 }}>{rupiah(d.total_amount)}</div><small className="muted">Bayar sebelum {dt(d.payment_due_at)}</small></div>
                <button className="btn lg" disabled={busy} onClick={pay}>{busy ? '…' : 'Bayar sekarang (Virtual Account)'}</button></div>
              <p className="muted" style={{ marginTop: 8 }}><small>Gateway pembayaran saat ini <b>sandbox</b> — tidak ada dana nyata yang ditarik sampai gateway resmi aktif.</small></p>
            </Card>
          )}
          <Card title={`Suborder per mitra (${d.orders.length})`}>
            {d.orders.map((o: any) => (
              <div key={o.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div><Link to={`/orders/${o.id}`}><b>{o.order_no}</b></Link> · {o.product_name} · {num(o.quantity)} {o.unit}<br /><small className="muted">{o.trade_model === 'RESELLER' ? 'Dijual oleh Supplier-ID' : o.supplier_name}</small></div>
                <div style={{ textAlign: 'right' }}><b>{rupiah(o.total_amount)}</b><br /><span className="badge">{o.status}</span></div>
              </div>
            ))}
            <p className="muted" style={{ marginTop: 8 }}><small>Setiap suborder dikirim, dikonfirmasi, dan (bila perlu) dikomplain terpisah. Buka suborder untuk timeline, OTP penerimaan, dan konfirmasi.</small></p>
          </Card>
          {d.status === 'PAID' && <button className="btn secondary" onClick={() => nav('/buyer/orders')}>Lihat semua pesanan</button>}
        </>
      )}
    </PublicLayout>
  );
}
