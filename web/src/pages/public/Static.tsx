import { Link } from 'react-router-dom';
import { PublicLayout } from '../../components/PublicLayout';

export function Mitra() {
  return (
    <PublicLayout>
      <section className="hero" style={{ paddingBottom: 12 }}>
        <div>
          <h1>Jual hasil panen & ternak <span>tanpa perantara berlapis</span></h1>
          <p className="lead">Supplier-ID menghubungkan petani, peternak, nelayan, kelompok tani, dan koperasi dengan pelanggan rumah tangga & bisnis. Anda mendeklarasikan kualitas, kami mengelola pesanan, pembayaran, dan pengiriman.</p>
          <div className="cta-row"><Link to="/register?role=supplier" className="btn lg">Daftar sebagai mitra</Link><Link to="/login" className="btn lg secondary">Masuk portal mitra</Link></div>
        </div>
        <div className="card">
          <b>Yang Anda dapatkan</b>
          <ul className="muted" style={{ paddingLeft: 18 }}>
            <li>Task inbox: terima/tolak pesanan, produksi/picking, QC & timbang, packing & label, serah ke kurir.</li>
            <li>Pembayaran per pesanan setelah pelanggan mengonfirmasi (maks. 24 jam setelah terima) dengan status transparan.</li>
            <li>Skor kualitas dari rekam jejak nyata; tanpa biaya pendaftaran.</li>
          </ul>
        </div>
      </section>
      <section className="section">
        <h2>Syarat & alur</h2>
        <div className="steps-row">
          {[['Daftar & verifikasi', 'Isi profil usaha, wilayah, rekening payout (diverifikasi admin).'], ['Deklarasikan batch', '≥3 foto aktual, atribut kualitas kategori, setujui Quality Self Declaration & Return Guarantee.'], ['Penuhi pesanan', 'Terima task, QC & timbang berat aktual, kemas dengan label QR, serahkan ke kurir.'], ['Terima pembayaran', 'Setelah konfirmasi pelanggan; potongan hanya untuk klaim yang terbukti menjadi tanggung jawab mitra.']].map(([t, d], i) => <div key={t} className="step-card"><div className="n">{i + 1}</div><b>{t}</b><p className="muted" style={{ marginTop: 4 }}>{d}</p></div>)}
        </div>
        <p className="muted" style={{ marginTop: 12 }}><small>Model dagang per kategori: <b>marketplace</b> (Anda penjual, platform fee dipotong dari transaksi sesuai konfigurasi, saat ini 15% nilai produk) atau <b>reseller</b> (Supplier-ID membeli pada harga Anda dan menjual dengan markup). Tarif dapat berubah dengan tanggal efektif dan tidak memengaruhi pesanan yang sudah dikonfirmasi.</small></p>
      </section>
    </PublicLayout>
  );
}

export function CaraBelanja() {
  return (
    <PublicLayout>
      <h1>Cara belanja</h1>
      <div className="steps-row" style={{ marginTop: 12 }}>
        {[['Daftar / masuk', 'Akun perorangan cukup nama, email, telepon. Bisnis (resto/hotel) dapat memakai RFQ & status PKP.'], ['Pilih & masukkan keranjang', 'Perhatikan harga per satuan, minimum pesan, toleransi berat, dan asal mitra.'], ['Checkout', 'Alamat, layanan opsional (cold chain, asuransi), promo. Rincian biaya per komponen; setujui kebijakan 24 jam & toleransi berat.'], ['Bayar', 'Virtual account/gateway (saat ini sandbox). Reservasi stok dilepas bila tidak dibayar dalam jendela pembayaran.'], ['Lacak', 'Mitra menyiapkan → QC & timbang → kemas berlabel → kurir menjemput → tracking suhu/lokasi.'], ['Terima dengan OTP', 'Berikan kode dari aplikasi ke kurir. Periksa barang; konfirmasi atau ajukan klaim (foto + video) dalam 24 jam.']].map(([t, d], i) => <div key={t} className="step-card"><div className="n">{i + 1}</div><b>{t}</b><p className="muted" style={{ marginTop: 4 }}>{d}</p></div>)}
      </div>
    </PublicLayout>
  );
}

export function Kebijakan() {
  return (
    <PublicLayout>
      <h1>Kebijakan transaksi & privasi</h1>
      <div className="card">
        <h3>Pembayaran & dana</h3><p className="muted">Pembayaran di muka saat checkout. Dana ditahan Supplier-ID dan dibayarkan ke mitra setelah konfirmasi penerimaan. Biaya layanan, packaging, ongkir, biaya pembayaran, dan pajak dirinci sebelum bayar dan terkunci saat checkout.</p>
        <h3>Konfirmasi penerimaan 24 jam</h3><p className="muted">Sejak bukti penerimaan sah (OTP penerima atau bukti kurir yang diverifikasi), pelanggan memiliki 24 jam untuk mengonfirmasi atau mengajukan klaim. Tanpa respons, pesanan dianggap sesuai (auto-confirm) hanya jika pembayaran terverifikasi dan tidak ada klaim/sengketa; selain itu operasional meninjau manual.</p>
        <h3>Berat aktual</h3><p className="muted">Produk berbasis berat ditimbang saat QC. Selisih dalam toleransi batch tidak mengubah harga; kekurangan di luar toleransi dikembalikan otomatis; kelebihan di luar toleransi memerlukan persetujuan pelanggan.</p>
        <h3>Klaim, retur & refund</h3><p className="muted">Klaim memerlukan foto + video kondisi barang saat diterima. Admin menilai bukti deklarasi mitra, pengiriman, dan penerimaan untuk menetapkan penyebab dan refund per komponen sesuai kebijakan retur yang berlaku. Produk segar tidak selalu dapat dikembalikan fisik; refund dapat diberikan tanpa pengembalian barang sesuai keputusan admin.</p>
        <h3>Privasi</h3><p className="muted">Data pribadi (nama, telepon, alamat) dipakai untuk pemrosesan pesanan dan pengiriman. Label paket memuat nama & alamat penerima minimum; QR hanya berisi ID paket. Lokasi foto bukti disimpan hanya dengan persetujuan. Akun dapat meminta penghapusan data melalui tiket.</p>
        <p><small className="muted">Dokumen ini ringkasan operasional; naskah hukum final memerlukan tinjauan legal sebelum transaksi komersial.</small></p>
      </div>
    </PublicLayout>
  );
}

export function Kontak() {
  return (
    <PublicLayout>
      <h1>Kontak</h1>
      <div className="card"><p>Pertanyaan pesanan: buat <Link to="/tiket/baru">tiket bantuan</Link> dari akun Anda agar terhubung ke pesanan.</p><p>Kemitraan & bisnis: <Link to="/mitra">halaman mitra</Link>.</p><p className="muted"><small>Kontak telepon/WhatsApp dan alamat kantor ditampilkan setelah dikonfirmasi pemilik (belum dikonfigurasi).</small></p></div>
    </PublicLayout>
  );
}

/** Info publik paket dari QR (aman: tanpa alamat/telepon/nilai). */
export function PublicPackage() {
  return <PublicLayout searchable={false}><PkgInfo /></PublicLayout>;
}
import { useParams } from 'react-router-dom';
import { api, dt, d as fmtDate, num } from '../../lib/api';
import { useAsync, Badge } from '../../components/ui';
function PkgInfo() {
  const { packageNo } = useParams();
  const p = useAsync<any>(() => api.get(`/api/public/packages/${packageNo}`), [packageNo]);
  if (p.error) return <div className="empty-state"><b>Paket tidak ditemukan</b>{packageNo}</div>;
  if (!p.data) return <div className="skeleton" style={{ minHeight: 100 }} />;
  const x = p.data;
  return <div className="card"><h1>{x.package_no} <Badge>{x.status}</Badge></h1><p><b>{x.product_name}</b> · {num(x.quantity, 2)} {x.unit}</p><p className="muted">Batch {x.batch_code} · panen {fmtDate(x.harvest_date)} · dikemas {dt(x.packed_at)}{x.expiry_date ? ` · baik sebelum ${fmtDate(x.expiry_date)}` : ''}</p><p className="muted">Asal: {x.supplier_name}{x.supplier_region ? `, ${x.supplier_region}` : ''}</p>{x.storage_instructions && <p>Simpan: {x.storage_instructions}</p>}<p><small className="muted">Data operasional lengkap memerlukan login.</small></p></div>;
}
