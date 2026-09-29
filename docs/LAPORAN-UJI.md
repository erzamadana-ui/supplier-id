# Laporan Uji — Supplier.id v1 (28 Sep 2026)

Lingkungan: Node 22.22, PostgreSQL 16.13, Vitest 5. Perintah: `cd server && npm test` → **3 file, 25 test, semua lolos** (unit 10, E2E 15). UI smoke test headless Chromium: 24 halaman × 3 peran terbuka tanpa error console/runtime/HTTP 500 (`docs/screenshots/`).

## Pemetaan Definition of Done (bagian W)

| # | Butir DoD | Test | Hasil |
|---|---|---|---|
| 1 | Normal successful transaction | E2E "1/5. transaksi normal sukses" | ✅ bayar → packing → pickup → tracking → tiba → terima penuh → SETTLED; jurnal BUYER_PAYMENT/PROVIDER_FEE/PACKAGING_COST/LOGISTICS_COST |
| 2 | Upcoming harvest → final harvest → transaction | E2E "2. upcoming harvest" | ✅ UPCOMING tidak bisa dipesan; pre-update wajib foto; final wajib 3 foto; READY_FOR_ORDER; order dari hasil panen; declaration accuracy 97,37% |
| 3 | Supplier photo quality declaration | E2E "3. deklarasi kualitas" | ✅ publish ditolak tanpa atribut wajib & 3 jenis foto; stock image ditolak; acceptance tersimpan (versi, waktu, IP); lokasi hanya dengan persetujuan |
| 4 | Buyer receiving inspection | E2E "4/6/8" | ✅ status ARRIVED_WAITING_INSPECTION; klaim tanpa foto/video ditolak (`RECEIVING_EVIDENCE_REQUIRED`) |
| 5 | Full acceptance | E2E "1/5" | ✅ accepted 1000, SETTLED |
| 6 | Partial acceptance | E2E "4/6/8" | ✅ 1.000 kg → 920 diterima / 80 ditolak → return case 80 kg |
| 7 | Full rejection | E2E "7. penolakan penuh" | ✅ REJECT 200 kg, atribusi LOGISTICS |
| 8 | Photo/video return evidence | E2E "4/6/8" + eligibility | ✅ eligibility otomatis: has_photo, has_video, jendela klaim, kuantitas, reason aktif |
| 9 | Return shipment | E2E "9. return logistics" | ✅ pickup → tracking (IN_TRANSIT) → diterima supplier → CLOSED → order SETTLED |
| 10 | Dispute | E2E "G/10" | ✅ supplier membantah → DISPUTED; side-by-side deklarasi vs bukti + sinyal suhu; admin memutuskan → RESOLVED |
| 11 | Refund | E2E "11/12/T" | ✅ refund prorata (produk+fee+packaging+pajak), kas keluar REFUND_PAID, payment PARTIALLY_REFUNDED |
| 12 | Supplier payout adjustment | E2E "11/12/T", "12/O" | ✅ hak supplier dipotong produk ditolak + biaya return logistics; payout = pending bersih; dashboard 5 angka |
| 13 | 15% platform fee | E2E "13/17/18/19/20" | ✅ rate 15%, Rp28 jt → Rp4,2 jt |
| 14 | Admin changes platform fee | E2E "14/15/16" | ✅ 15% → 12%: previous_value, reason, created_by, audit log; effective date masa depan tidak dipakai; dual control (PENDING_APPROVAL, approver ≠ pembuat) |
| 15 | Old order retains previous fee | idem | ✅ order lama tetap 15% / Rp4,2 jt, `fee_config_id` lama |
| 16 | New order uses new fee | idem | ✅ order baru 12%; override per supplier 10% (arsitektur R) |
| 17 | Packaging charge | E2E "13/17…" + unit | ✅ 1.000 kg × Rp250 = Rp250.000 |
| 18 | Logistics charge | idem | ✅ 150.000 + 3.500×km + 350×kg |
| 19 | Payment fee | idem + unit | ✅ terpisah, tidak dipungut PPN (pass-through), non-refundable default |
| 20 | Tax calculation | unit "pajak tidak diasumsikan sama…" + E2E | ✅ PPN per komponen; produk PKP kategori standar kena 11%, kebutuhan pokok/non-PKP tidak; dpp_factor 11/12 diuji |
| 21 | Ledger reconciliation | E2E "21. rekonsiliasi global" + per order | ✅ Money In + Receivables = Money Out + Liability + Tax + Net Revenue, variance 0, semua jurnal seimbang, Money In = Σ pembayaran buyer, dashboard monetisasi = ledger |

Tambahan: pembatalan setelah bayar (refund penuh kecuali payment fee, stok kembali), RFQ → quotation → counter → accept, enforcement Quality Score (LISTING_LIMITED memblokir publikasi baru), buyer tidak bisa mengakses endpoint admin (403).

Contoh angka (spesifikasi bagian M, unit test): produk Rp10.000.000 → fee 15% Rp1.500.000, packaging Rp250.000, logistik Rp500.000, payment fee Rp100.000, PPN jasa 11% × Rp2.250.000 = Rp247.500 (produk kebutuhan pokok dibebaskan) → total Rp12.597.500 = penjumlahan seluruh komponen.

## Asumsi & keterbatasan data (dicantumkan agar tidak hilang saat dokumen beredar)

1. **Pajak**: tarif/kelas PPN default adalah asumsi teknis (PPN 11% jasa platform; barang kebutuhan pokok dibebaskan; supplier non-PKP tidak memungut; payment fee pass-through). Belum divalidasi Finance/konsultan pajak. Semua dapat diubah dari Admin → Tax Engine (termasuk `dpp_factor` 11/12).
2. **Payment gateway & kurir**: mock instan. Biaya provider gateway (`payment.provider_fee_*`) dan biaya logistik (`logistics.cost_ratio`) adalah parameter estimasi, bukan tagihan nyata.
3. **Kebijakan refund** (`return.policy`) adalah usulan default: kesalahan SUPPLIER/PACKAGING → supplier menanggung produk & return logistics; LOGISTICS → platform klaim ke penyedia logistik (piutang), supplier tetap dibayar; BUYER_RECEIVING → tanpa refund; OTHER/UNDETERMINED → platform menanggung. Ini keputusan bisnis yang perlu ditetapkan GM/Legal.
4. **Quality Score**: bobot & ambang enforcement default (return rate >10/15/20/30/40%) belum dikalibrasi dengan data nyata; `min_orders=3` agar demo terlihat — di produksi sebaiknya ≥10.
5. Foto/video disimpan di disk lokal server tanpa deteksi stock-image otomatis (hanya deklarasi supplier + hash + timestamp); verifikasi visual tetap manusia.
6. Belum ada notifikasi push/email/WA; reminder pre-harvest tersedia sebagai endpoint & alert di dashboard supplier.

## Keputusan yang masih diperlukan dari GM

- Tarif nyata: packaging/kg, logistik (dasar, per km, per kg), payment fee ke buyer vs biaya provider, jendela klaim (default 24 jam).
- Matriks refund per atribusi penyebab dan siapa menanggung return logistics.
- Perlakuan PPN per komponen & status PKP Supplier.id (validasi Finance).
- Provider pembayaran (Finpay/Midtrans) dan mitra logistik/cold chain untuk mengganti mock.
