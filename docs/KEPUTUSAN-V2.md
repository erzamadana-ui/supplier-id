# Keputusan Bisnis Supplier-ID v2 (dikonfirmasi Erza, 4 Okt 2026)

| # | Keputusan | Pilihan Erza | Konsekuensi desain |
|---|---|---|---|
| 1 | Model bisnis | **Hibrida per kategori** | `categories.trade_model` = `MARKETPLACE` (mitra penjual, platform fee %) atau `RESELLER` (Supplier-ID membeli dari mitra pada harga mitra, menjual dengan markup % per kategori; faktur atas nama Supplier-ID; margin = pendapatan platform; mitra dibayar harga beli × kuantitas diterima). Default semua kategori: MARKETPLACE sampai admin mengubah. |
| 2 | Segmen & pembayaran | **B2C + B2B, bayar saat checkout** | Pendaftaran pelanggan perorangan (tanpa nama perusahaan) & bisnis (PKP/non-PKP, RFQ). COD/tempo **tidak** diaktifkan. Reservasi stok dilepas bila pembayaran kedaluwarsa (jendela bayar diatur di setting, usulan awal 2 jam [ASUMSI]). |
| 3 | Konfirmasi 24 jam | **Auto-confirm aktif** | `confirmation_due_at = delivered_at + 24 jam` (waktu server, UTC; tampil WIB). Auto-confirm hanya bila: policy aktif (`confirmation.auto_confirm_enabled=true`), diberitahukan di checkout, bukti penerimaan valid (OTP penerima atau foto kurir terverifikasi), pembayaran pelanggan `PAID`, tidak ada return case/hold. Selain itu → eskalasi ke operasional, dana tidak dilepas. |
| 4 | QC/packing & label | **Mitra**, label **A4/PDF** (printer biasa) | QC record (timbang berat aktual, suhu, grade, foto) dibuat mitra; label PDF A4 dengan QR (ID paket) + Code 128; gudang Supplier-ID opsional tahap lanjutan. |

## Interpretasi yang masih [USULAN] (belum dikonfirmasi, dipakai sebagai default yang bisa diubah admin)
- SLA eksekusi payout: task dibuat otomatis saat konfirmasi → maker mengajukan → checker menyetujui → transfer **H+1 hari kerja** setelah approval (`payout.sla_hours=24`, tampil ke mitra). Transfer nyata hanya jika provider payout terkonfigurasi; sebelumnya status berhenti di `APPROVED` dan ditandai "menunggu provider".
- Komisi marketplace: tetap 15% (existing, bisa diubah per scope). Markup reseller default 20% per kategori [ASUMSI].
- Ongkir ditanggung pelanggan (existing), promo ditanggung platform (existing), refund mengikuti matriks `return.policy` (existing).
- Toleransi berat aktual: `batches.weight_tolerance_pct` (default 2%) disetujui pelanggan saat checkout; di luar toleransi → tindakan pelanggan (setuju bayar selisih / minta dikemas sesuai toleransi).
- Masa komplain: jendela konfirmasi 24 jam = masa komplain untuk produk segar [ASUMSI; cek UU Perlindungan Konsumen/Legal].
- Zona waktu operasional: Asia/Jakarta.
- Printer: A4 lewat browser (print → PDF). Thermal 80 mm tersedia sebagai template kedua tanpa uji perangkat.
