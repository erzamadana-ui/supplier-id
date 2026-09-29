import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import LoginPage from './pages/Login';
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

const NAV: Record<string, { to: string; label: string }[]> = {
  SUPPLIER: [
    { to: '/supplier', label: 'Dashboard & Payout' },
    { to: '/supplier/products', label: 'Produk & Batch' },
    { to: '/supplier/rfqs', label: 'RFQ & Penawaran' },
    { to: '/supplier/orders', label: 'Pesanan' },
    { to: '/returns', label: 'Retur & Dispute' },
  ],
  BUYER: [
    { to: '/buyer', label: 'Marketplace' },
    { to: '/buyer/rfqs', label: 'RFQ Saya' },
    { to: '/buyer/orders', label: 'Pesanan' },
    { to: '/returns', label: 'Retur & Klaim' },
  ],
  ADMIN: [
    { to: '/admin', label: 'Finance → Monetization' },
    { to: '/admin/fees', label: 'Fees & Monetization' },
    { to: '/admin/tax', label: 'Tax Engine' },
    { to: '/admin/settings', label: 'Konfigurasi' },
    { to: '/admin/catalog', label: 'Kategori & Reason Code' },
    { to: '/admin/suppliers', label: 'Supplier & Quality Score' },
    { to: '/admin/orders', label: 'Semua Order' },
    { to: '/returns', label: 'Retur & Dispute' },
    { to: '/admin/ledger', label: 'Ledger & Rekonsiliasi' },
    { to: '/admin/payouts', label: 'Payout Supplier' },
  ],
};

function Shell({ children }: { children: React.ReactNode }) {
  const { user, organization, logout } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Supplier<span>.id</span></div>
        <div className="role">{user.role === 'ADMIN' ? 'Admin Panel' : user.role === 'SUPPLIER' ? 'Portal Supplier' : 'Portal Buyer'}</div>
        <nav>{NAV[user.role].map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/supplier' || n.to === '/buyer' || n.to === '/admin'}>{n.label}</NavLink>)}</nav>
        <div className="user">
          <div><b>{user.name}</b></div>
          <div>{organization?.name ?? 'Supplier.id'}</div>
          <div>{user.email}</div>
          <button className="btn secondary small" onClick={logout}>Keluar</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function Home() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'ADMIN' ? '/admin' : user.role === 'SUPPLIER' ? '/supplier' : '/buyer'} replace />;
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={BASENAME}>
      <AuthProvider><App /></AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
