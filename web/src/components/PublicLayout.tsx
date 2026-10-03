import { ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

/** Status online/offline (PWA): tampilkan banner, nonaktifkan aksi tulis. */
export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/** Jumlah item keranjang (hanya BUYER yang login). */
export function useCartCount() {
  const { user } = useAuth();
  const [n, setN] = useState(0);
  const refresh = async () => { if (user?.role !== 'BUYER') return setN(0); try { setN((await api.get('/api/cart')).items.length); } catch { /* offline */ } };
  useEffect(() => { refresh(); const h = () => refresh(); window.addEventListener('cart:changed', h); return () => window.removeEventListener('cart:changed', h); /* eslint-disable-next-line */ }, [user?.id]);
  return n;
}

const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
export const ICONS = {
  home: 'M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z',
  catalog: 'M4 6h16M4 12h16M4 18h10',
  cart: 'M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  orders: 'M9 2h6l1 3h4v16H4V5h4zM8 12h8M8 16h5',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  search: 'M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z',
};

export function PublicLayout({ children, searchable = true }: { children: ReactNode; searchable?: boolean }) {
  const { user, logout } = useAuth();
  const nav = useNavigate(); const loc = useLocation();
  const online = useOnline(); const cartCount = useCartCount();
  const [qText, setQ] = useState(new URLSearchParams(loc.search).get('q') ?? '');
  const dashboard = user?.role === 'ADMIN' ? '/admin' : user?.role === 'SUPPLIER' ? '/supplier' : user?.role === 'COURIER' ? '/courier' : '/buyer/orders';
  return (
    <div className="pub">
      {!online && <div className="offline-bar" role="status">Anda sedang offline — data ditampilkan dari cache; aksi akan gagal sampai koneksi kembali.</div>}
      <header className="topnav">
        <div className="inner">
          <Link to="/" className="brand" aria-label="Supplier-ID beranda">Supplier<span>-ID</span></Link>
          {searchable && (
            <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/katalog?q=${encodeURIComponent(qText)}`); }}>
              <input aria-label="Cari produk" placeholder="Cari sayur, telur, ikan, daging…" value={qText} onChange={(e) => setQ(e.target.value)} />
              <button className="btn secondary" type="submit" aria-label="Cari"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={ICONS.search} /></svg></button>
            </form>
          )}
          <nav className="links" aria-label="Navigasi utama">
            <NavLink to="/katalog">Katalog</NavLink>
            <NavLink to="/mitra">Jadi Mitra</NavLink>
            {user ? <NavLink to={dashboard}>{user.role === 'BUYER' ? 'Pesanan' : 'Dashboard'}</NavLink> : <NavLink to="/login">Masuk</NavLink>}
            {user ? <a href="#" onClick={(e) => { e.preventDefault(); logout(); nav('/'); }}>Keluar</a> : <NavLink to="/register" className="btn" style={{ color: '#fff' }}>Daftar</NavLink>}
            {(!user || user.role === 'BUYER') && <NavLink to="/keranjang" className="cart-btn" aria-label={`Keranjang, ${cartCount} item`}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={ICONS.cart} /></svg>{cartCount > 0 && <span className="count">{cartCount}</span>}</NavLink>}
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer>
        <div className="inner">
          <div><b>Supplier-ID</b><br />Belanja hasil tani, ternak & laut langsung dari mitra petani/peternak/nelayan. Deklarasi kualitas, bukti foto, jaminan retur.</div>
          <div><b>Bantuan</b><br /><Link to="/cara-belanja">Cara belanja</Link><br /><Link to="/kebijakan">Kebijakan transaksi & privasi</Link><br /><Link to="/kontak">Kontak</Link></div>
          <div><b>Mitra</b><br /><Link to="/mitra">Daftar sebagai mitra</Link><br /><Link to="/login">Masuk portal mitra</Link></div>
          <div><small>© {new Date().getFullYear()} Supplier-ID · bagian dari AntarKita Indonesia. <Link to="/login?role=admin" style={{ color: 'var(--muted)' }}>Admin</Link></small></div>
        </div>
      </footer>
      {(!user || user.role === 'BUYER') && (
        <nav className="bottomnav" aria-label="Navigasi bawah">
          <NavLink to="/" end><Icon d={ICONS.home} />Beranda</NavLink>
          <NavLink to="/katalog"><Icon d={ICONS.catalog} />Katalog</NavLink>
          <NavLink to="/keranjang"><Icon d={ICONS.cart} />Keranjang{cartCount > 0 ? ` (${cartCount})` : ''}</NavLink>
          <NavLink to={user ? '/buyer/orders' : '/login'}><Icon d={ICONS.orders} />Pesanan</NavLink>
          <NavLink to={user ? '/akun' : '/login'}><Icon d={ICONS.user} />Akun</NavLink>
        </nav>
      )}
    </div>
  );
}

/** Skeleton kartu produk. */
export function ProductSkeleton({ n = 8 }: { n?: number }) {
  return <div className="product-grid" aria-busy="true">{Array.from({ length: n }).map((_, i) => <div key={i} className="product"><div className="img skeleton" style={{ minHeight: 150 }} /><div className="body"><div className="skeleton" /><div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" style={{ width: '40%' }} /></div></div>)}</div>;
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><b>{title}</b>{children}</div>;
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="alert error" role="alert">{message} {onRetry && <button className="btn small secondary" onClick={onRetry} style={{ marginLeft: 8 }}>Coba lagi</button>}</div>;
}
