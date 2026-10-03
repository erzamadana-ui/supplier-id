import { Link } from 'react-router-dom';
import { PublicLayout, EmptyState } from '../../components/PublicLayout';
import { api } from '../../lib/api';
import { useAsync } from '../../components/ui';
import { ProductCard } from './Catalog';

/** Ilustrasi hero (vektor orisinal sederhana — bukan reproduksi aset referensi). */
function HeroArt() {
  return (
    <svg viewBox="0 0 520 340" role="img" aria-label="Ilustrasi kebun dan hasil panen">
      <defs><linearGradient id="sky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#fbfaf6" /><stop offset="1" stopColor="#efede6" /></linearGradient></defs>
      <rect width="520" height="340" rx="28" fill="url(#sky)" />
      <circle cx="420" cy="78" r="38" fill="#F1D85B" opacity=".9" />
      <ellipse cx="260" cy="300" rx="260" ry="60" fill="#E2D6B7" />
      <path d="M0 250 Q130 200 260 240 T520 230 V340 H0z" fill="#6CA688" opacity=".85" />
      <path d="M0 280 Q140 240 260 275 T520 265 V340 H0z" fill="#506B5D" />
      {[60, 130, 200, 270, 340, 410].map((x, i) => (
        <g key={x} transform={`translate(${x} ${235 - (i % 2) * 8})`}>
          <path d="M0 40 C-6 20 -20 10 -28 -4 C-10 -2 2 10 0 40z" fill="#2f6b4f" />
          <path d="M0 40 C6 20 20 10 28 -4 C10 -2 -2 10 0 40z" fill="#3f8a66" />
          <circle cx="0" cy="-2" r="7" fill="#DF9C6C" />
        </g>
      ))}
      <g transform="translate(100 120)"><rect x="0" y="0" width="120" height="70" rx="12" fill="#fff" stroke="#e4e1d7" /><rect x="12" y="12" width="40" height="40" rx="8" fill="#e6f1ea" /><rect x="60" y="14" width="48" height="8" rx="4" fill="#cfe4d7" /><rect x="60" y="30" width="36" height="8" rx="4" fill="#cfe4d7" /><rect x="60" y="46" width="44" height="10" rx="5" fill="#2f6b4f" /></g>
      <g transform="translate(300 100)"><rect x="0" y="0" width="150" height="90" rx="12" fill="#fff" stroke="#e4e1d7" /><text x="12" y="28" fontSize="11" fill="#6b7a70" fontFamily="Inter, sans-serif">Deklarasi kualitas</text><text x="12" y="52" fontSize="18" fontWeight="700" fill="#2f6b4f" fontFamily="Inter, sans-serif">3 foto ✓</text><text x="12" y="74" fontSize="11" fill="#6b7a70" fontFamily="Inter, sans-serif">Jaminan retur · OTP terima</text></g>
    </svg>
  );
}

export default function Landing() {
  const cats = useAsync<any[]>(() => api.get('/api/categories'), []);
  const listings = useAsync<any[]>(() => api.get('/api/listings'), []);
  const stats = useAsync<any>(() => api.get('/api/public/stats').catch(() => null), []);
  return (
    <PublicLayout>
      <section className="hero">
        <div>
          <h1>Hasil tani & ternak <span>segar dari sumbernya</span></h1>
          <p className="lead">Pesan sayur, telur, ikan, dan daging langsung dari mitra petani, peternak, dan nelayan. Setiap produk dideklarasikan dengan foto aktual, dikirim dengan kode penerimaan, dan dijamin retur bila tidak sesuai.</p>
          <div className="cta-row">
            <Link to="/katalog" className="btn lg">Belanja sekarang</Link>
            <Link to="/mitra" className="btn lg secondary">Daftar sebagai mitra</Link>
          </div>
          <p style={{ marginTop: 14 }}><small className="muted">Wilayah layanan saat ini: {stats.data?.regions?.length ? stats.data.regions.join(', ') : 'Riau & Sumatera Barat (mitra terdaftar)'} · Konfirmasi penerimaan 24 jam · Pembayaran di muka (sandbox sampai gateway resmi aktif)</small></p>
        </div>
        <div className="art"><HeroArt /></div>
      </section>

      <section className="section" id="kategori">
        <h2>Kategori produk</h2>
        <p className="sub">Semua kategori memakai atribut kualitas dinamis (kesegaran, ukuran, grade, suhu) yang diisi mitra dan diverifikasi foto.</p>
        {cats.loading && <div className="cat-grid">{[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="cat-card skeleton" />)}</div>}
        {cats.data && <div className="cat-grid">{cats.data.filter((c) => c.active !== false).map((c) => (
          <Link key={c.code} to={`/katalog?category=${c.code}`} className="cat-card"><b>{c.name}</b><small>{c.trade_model === 'RESELLER' ? 'Dijual oleh Supplier-ID' : 'Langsung dari mitra'}</small><small>{(c.attribute_schema ?? []).length} atribut kualitas</small></Link>
        ))}</div>}
      </section>

      <section className="section" id="cara-belanja">
        <h2>Cara belanja</h2>
        <div className="steps-row">
          {[
            ['Pilih produk', 'Lihat harga per satuan, minimum pesan, foto aktual, asal mitra, dan skor kualitas.'],
            ['Checkout & bayar', 'Harga terkunci saat checkout: produk, biaya layanan, packaging, ongkir, pajak — tanpa biaya tersembunyi.'],
            ['Mitra siapkan & QC', 'Mitra menimbang berat aktual; selisih di luar toleransi selalu meminta persetujuan Anda.'],
            ['Terima & konfirmasi', 'Berikan OTP ke kurir, periksa barang, konfirmasi dalam 24 jam. Tidak sesuai? Ajukan klaim dengan foto + video.'],
          ].map(([t, d], i) => <div key={t} className="step-card"><div className="n">{i + 1}</div><b>{t}</b><p className="muted" style={{ marginTop: 4 }}>{d}</p></div>)}
        </div>
      </section>

      <section className="section">
        <div className="row between"><h2>Produk siap dipesan</h2><Link to="/katalog">Lihat semua →</Link></div>
        {listings.loading && <p className="muted">Memuat…</p>}
        {listings.error && <EmptyState title="Katalog belum dapat dimuat">{listings.error}</EmptyState>}
        {listings.data && (listings.data.length ? <div className="product-grid">{listings.data.slice(0, 8).map((l) => <ProductCard key={l.id} l={l} />)}</div> : <EmptyState title="Belum ada produk terpublikasi">Mitra sedang mendaftarkan batch. Kembali lagi segera.</EmptyState>)}
      </section>

      <section className="section" id="kualitas">
        <h2>Kualitas & asal yang bisa diperiksa</h2>
        <div className="grid cols-3">
          <div className="card"><b>Deklarasi kualitas mitra</b><p className="muted">Minimal 3 foto aktual (keseluruhan, close-up, kemasan) per batch, dengan waktu pengambilan. Stock image ditolak sistem.</p></div>
          <div className="card"><b>Jaminan retur</b><p className="muted">Mitra menandatangani deklarasi & jaminan retur per batch (versi, waktu, IP tercatat). Klaim dinilai dari perbandingan bukti sebelum–pengiriman–penerimaan.</p></div>
          <div className="card"><b>Telusur batch</b><p className="muted">Setiap paket berlabel QR/Code 128 yang terhubung ke batch, mitra, dan pesanan untuk investigasi atau recall.</p></div>
        </div>
        <p><small className="muted">Supplier-ID tidak menampilkan testimoni, sertifikasi, atau statistik yang belum terverifikasi. Angka pesanan & mitra tampil setelah ada data transaksi nyata.</small></p>
      </section>

      <section className="section faq" id="faq">
        <h2>Pertanyaan umum</h2>
        <details><summary>Kapan saya membayar?</summary><p className="muted">Saat checkout. Dana ditahan Supplier-ID dan baru dibayarkan ke mitra setelah Anda mengonfirmasi penerimaan (atau 24 jam setelah bukti penerimaan sah tanpa klaim).</p></details>
        <details><summary>Bagaimana jika berat aktual berbeda?</summary><p className="muted">Toleransi berat per batch (umumnya 2%) Anda setujui saat checkout. Kekurangan di luar toleransi otomatis dikembalikan; kelebihan di luar toleransi memerlukan persetujuan Anda — tidak ada penarikan dana diam-diam.</p></details>
        <details><summary>Bagaimana klaim barang tidak sesuai?</summary><p className="muted">Saat barang tiba, pilih "diterima sebagian" atau "ditolak", unggah foto + video, pilih alasan. Admin menilai bukti dan menetapkan refund per komponen.</p></details>
        <details><summary>Apakah ada COD?</summary><p className="muted">Belum. Pembayaran di muka melalui gateway resmi (saat ini sandbox/uji).</p></details>
      </section>
    </PublicLayout>
  );
}
