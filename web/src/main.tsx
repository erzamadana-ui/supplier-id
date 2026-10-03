import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import LoginPage from './pages/Login';
import RegisterPage from './pages/Register';
import AccountPage from './pages/Account';
import SupplierDashboard from './pages/supplier/Dashboard';
import SupplierProducts from './pages/supplier/Products';
import SupplierBatchDetail from './pages/supplier/BatchDetail';
import SupplierOrders from './pages/supplier/Orders';
import SupplierRfqs from './pages/supplier/Rfqs';
import BuyerMarket from './pages/buyer/Market';
import BuyerListing from './pages/buyer/Listing';
import BuyerOrders from './pages/buyer/Orders';
import BuyerRfqs from './pages/buyer/Rfqs';
import OrderDetail from './pages/OrderDetail';
import ReturnsList from './pages/Returns';
import ReturnDetail from './pages/ReturnDetail';
import AdminMonetization from './pages/admin/Monetization';
import AdminFees from './pages/admin/Fees';
import AdminTax from './pages/admin/Tax';
import AdminSettings from './pages/admin/Settings';
import AdminSuppliers from './pages/admin/Suppliers';
import AdminLedger from './pages/admin/Ledger';
import AdminPayouts from './pages/admin/Payouts';
import AdminCatalog from './pages/admin/Catalog';
import AdminOrders from './pages/admin/Orders';
import Landing from './pages/public/Landing';
import Catalog from './pages/public/Catalog';
import Product from './pages/public/Product';
import { Mitra, CaraBelanja, Kebijakan, Kontak, PublicPackage } from './pages/public/Static';
import Cart, { Checkout, OrderGroup } from './pages/buyer/Cart';
import Tasks, { TaskDetail } from './pages/supplier/Tasks';
import Manifest, { ShipmentDetail } from './pages/courier/Courier';
import { OpsDashboard, Escalations, Dispatch, Finance, Staff } from './pages/admin/Ops';
import Tickets, { NewTicket, TicketDetail } from './pages/Tickets';
import Label from './pages/Label';
import { hasPerm } from './lib/api';
import { PublicLayout } from './components/PublicLayout';

const NAV: Record<string, { to: string; label: string; perm?: string }[]> = {
  SUPPLIER: [
    { to: '/supplier/tasks', label: 'Task inbox' },
    { to: '/supplier', label: 'Dashboard & pembayaran' },
    { to: '/supplier/products', label: 'Produk & Batch' },
    { to: '/supplier/rfqs', label: 'RFQ & Penawaran' },
    { to: '/supplier/orders', label: 'Pesanan' },
    { to: '/returns', label: 'Retur & Dispute' },
    { to: '/tiket', label: 'Tiket bantuan' },
  ],
  BUYER: [
    { to: '/katalog', label: 'Katalog' },
    { to: '/buyer/orders', label: 'Pesanan' },
    { to: '/buyer/rfqs', label: 'RFQ Saya (bisnis)' },
    { to: '/returns', label: 'Retur & Klaim' },
    { to: '/tiket', label: 'Bantuan' },
  ],
  COURIER: [
    { to: '/courier', label: 'Manifest' },
  ],
  ADMIN: [
    { to: '/admin/ops', label: 'Operasional hari ini', perm: 'orders.read' },
    { to: '/admin/escalations', label: 'Eskalasi', perm: 'escalations.manage' },
    { to: '/admin/dispatch', label: 'Dispatch & kurir', perm: 'shipments.manage' },
    { to: '/admin/finance', label: 'Finance → Payment task', perm: 'finance.read' },
    { to: '/admin', label: 'Finance → Monetization', perm: 'finance.read' },
    { to: '/admin/fees', label: 'Fees & Monetization', perm: 'settings.read' },
    { to: '/admin/tax', label: 'Tax Engine', perm: 'settings.read' },
    { to: '/admin/settings', label: 'Konfigurasi', perm: 'settings.read' },
    { to: '/admin/catalog', label: 'Kategori & Reason Code', perm: 'catalog.manage' },
    { to: '/admin/suppliers', label: 'Mitra & Quality Score', perm: 'partners.read' },
    { to: '/admin/orders', label: 'Semua Order', perm: 'orders.read' },
    { to: '/returns', label: 'Retur & Dispute', perm: 'returns.read' },
    { to: '/tiket', label: 'Tiket CS', perm: 'tickets.read' },
    { to: '/admin/ledger', label: 'Ledger & Rekonsiliasi', perm: 'ledger.read' },
    { to: '/admin/payouts', label: 'Payout (saldo mitra)', perm: 'finance.read' },
    { to: '/admin/staff', label: 'Staf & kurir', perm: 'partners.manage' },
  ],
};

function Shell({ children }: { children: React.ReactNode }) {
  const { user, organization, logout } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} state={{ from: loc }} replace />;
  if (user.role === 'BUYER') return <PublicLayout searchable={false}><div className="buyer-shell">{children}</div></PublicLayout>; // pelanggan: navigasi belanja + bottom nav
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Supplier<span>-ID</span></div>
        <div className="role">{user.role === 'ADMIN' ? `Admin Panel · ${user.adminRole ?? 'OWNER'}` : user.role === 'SUPPLIER' ? 'Portal Mitra' : user.role === 'COURIER' ? 'Kurir' : 'Pelanggan'}</div>
        <nav>{NAV[user.role].filter((n) => !n.perm || hasPerm(user, n.perm) || (user.permissions ?? []).includes('*')).map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/supplier' || n.to === '/buyer' || n.to === '/admin' || n.to === '/courier'}>{n.label}</NavLink>)}</nav>
        <div className="user">
          <div><b>{user.name}</b></div>
          <div>{organization?.name ?? 'Supplier.id'}</div>
          <div>{user.email}</div>
          <NavLink to="/akun" className="small">Akun & kata sandi</NavLink>
          <button className="btn secondary small" onClick={logout}>Keluar</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function Home() {
  const { user } = useAuth();
  if (user?.role === 'ADMIN') return <Navigate to="/admin/ops" replace />;
  if (user?.role === 'SUPPLIER') return <Navigate to="/supplier/tasks" replace />;
  if (user?.role === 'COURIER') return <Navigate to="/courier" replace />;
  return <Landing />; // publik & pelanggan: landing page
}

function Guard({ role, children }: { role: string; children: React.ReactNode }) {
  const { user } = useAuth();
  if (user && user.role !== role) return <Navigate to="/" replace />;
  return <Shell>{children}</Shell>;
}

function App() {
  const { loading } = useAuth();
  if (loading) return <div className="main">Memuat…</div>;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/katalog" element={<Catalog />} />
      <Route path="/katalog/:id" element={<Product />} />
      <Route path="/mitra" element={<Mitra />} />
      <Route path="/cara-belanja" element={<CaraBelanja />} />
      <Route path="/kebijakan" element={<Kebijakan />} />
      <Route path="/kontak" element={<Kontak />} />
      <Route path="/p/:packageNo" element={<PublicPackage />} />
      <Route path="/keranjang" element={<Cart />} />
      <Route path="/checkout" element={<Checkout />} />
      <Route path="/pesanan/:id" element={<OrderGroup />} />
      <Route path="/akun" element={<Shell><AccountPage /></Shell>} />
      <Route path="/tiket" element={<Shell><Tickets /></Shell>} />
      <Route path="/tiket/baru" element={<Shell><NewTicket /></Shell>} />
      <Route path="/tiket/:id" element={<Shell><TicketDetail /></Shell>} />
      <Route path="/labels/:id" element={<Label />} />
      <Route path="/supplier/tasks" element={<Guard role="SUPPLIER"><Tasks /></Guard>} />
      <Route path="/supplier/tasks/:id" element={<Guard role="SUPPLIER"><TaskDetail /></Guard>} />
      <Route path="/courier" element={<Guard role="COURIER"><Manifest /></Guard>} />
      <Route path="/courier/shipments/:id" element={<Guard role="COURIER"><ShipmentDetail /></Guard>} />
      <Route path="/admin/ops" element={<Guard role="ADMIN"><OpsDashboard /></Guard>} />
      <Route path="/admin/escalations" element={<Guard role="ADMIN"><Escalations /></Guard>} />
      <Route path="/admin/dispatch" element={<Guard role="ADMIN"><Dispatch /></Guard>} />
      <Route path="/admin/finance" element={<Guard role="ADMIN"><Finance /></Guard>} />
      <Route path="/admin/staff" element={<Guard role="ADMIN"><Staff /></Guard>} />
      <Route path="/" element={<Home />} />
      <Route path="/supplier" element={<Guard role="SUPPLIER"><SupplierDashboard /></Guard>} />
      <Route path="/supplier/products" element={<Guard role="SUPPLIER"><SupplierProducts /></Guard>} />
      <Route path="/supplier/batches/:id" element={<Guard role="SUPPLIER"><SupplierBatchDetail /></Guard>} />
      <Route path="/supplier/rfqs" element={<Guard role="SUPPLIER"><SupplierRfqs /></Guard>} />
      <Route path="/supplier/orders" element={<Guard role="SUPPLIER"><SupplierOrders /></Guard>} />
      <Route path="/buyer" element={<Guard role="BUYER"><BuyerMarket /></Guard>} />
      <Route path="/buyer/listings/:id" element={<Guard role="BUYER"><BuyerListing /></Guard>} />
      <Route path="/buyer/rfqs" element={<Guard role="BUYER"><BuyerRfqs /></Guard>} />
      <Route path="/buyer/orders" element={<Guard role="BUYER"><BuyerOrders /></Guard>} />
      <Route path="/orders/:id" element={<Shell><OrderDetail /></Shell>} />
      <Route path="/returns" element={<Shell><ReturnsList /></Shell>} />
      <Route path="/returns/:id" element={<Shell><ReturnDetail /></Shell>} />
      <Route path="/admin" element={<Guard role="ADMIN"><AdminMonetization /></Guard>} />
      <Route path="/admin/fees" element={<Guard role="ADMIN"><AdminFees /></Guard>} />
      <Route path="/admin/tax" element={<Guard role="ADMIN"><AdminTax /></Guard>} />
      <Route path="/admin/settings" element={<Guard role="ADMIN"><AdminSettings /></Guard>} />
      <Route path="/admin/catalog" element={<Guard role="ADMIN"><AdminCatalog /></Guard>} />
      <Route path="/admin/suppliers" element={<Guard role="ADMIN"><AdminSuppliers /></Guard>} />
      <Route path="/admin/orders" element={<Guard role="ADMIN"><AdminOrders /></Guard>} />
      <Route path="/admin/ledger" element={<Guard role="ADMIN"><AdminLedger /></Guard>} />
      <Route path="/admin/payouts" element={<Guard role="ADMIN"><AdminPayouts /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// SPA fallback GitHub Pages: 404.html mengarahkan ke /supplier-id/?p=<path asli>
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');
const sp = new URLSearchParams(window.location.search);
if (sp.get('p')) window.history.replaceState(null, '', BASENAME + sp.get('p'));

// Android (Capacitor): deep link → rute aplikasi; token push → server (pengiriman push aktif setelah Firebase dikonfigurasi)
if ((window as any).Capacitor?.isNativePlatform?.()) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appUrlOpen', ({ url }) => { const m = url.match(/\/supplier-id(\/.*)?$/); if (m) window.history.pushState(null, '', m[1] || '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
  }).catch(() => undefined);
}

// PWA: service worker (cache shell + GET API untuk tampilan offline; aksi tulis tidak di-cache)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={BASENAME}>
      <AuthProvider><App /></AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
