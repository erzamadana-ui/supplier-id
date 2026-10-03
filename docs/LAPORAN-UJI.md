# Laporan Uji — Supplier-ID (v1 28 Sep 2026; v2 4 Okt 2026)

Lingkungan: Node 22.22, PostgreSQL 16.13, Vitest 5. Perintah: `cd server && npm test` → **3 file, 27 test, semua lolos** (unit 10, E2E 17; tambahan 4 Okt: ganti kata sandi + pencabutan sesi, purge data uji dengan rekonsiliasi tetap seimbang). UI smoke test headless Chromium: 24 halaman × 3 peran terbuka tanpa error console/runtime/HTTP 500 (`docs/screenshots/`).

## v2 — hasil uji (4 Okt 2026, commit lihat `git log`, lokal Node 22 + PostgreSQL 16)
**Otomatis `cd server && npm test`: 4 file, 46 test lolos** (unit 10, E2E v1 17, E2E v2 19). Skenario acceptance v2 → test:
| Skenario | Test | Hasil |
|---|---|---|
| Checkout & payment normal (web/Android = backend sama) | v2 "checkout 2 item dari 2 mitra" | ✅ 1 order induk, 2 suborder, PAID, task ACCEPTANCE per mitra |
| Dua pembeli stok terakhir | v2 "dua pembeli membeli stok terakhir" | ✅ Promise.all → [201, 409]; stok 0, tidak negatif |
| Multi-mitra & parsial | checkout multi-mitra + "komplain (partial accept)" | ✅ task/shipment/konfirmasi/payment task per suborder; parsial → task dibuat setelah retur selesai dengan neto setelah potongan |
| Mitra menolak/terlambat | "mitra menolak → eskalasi"; job `markLateTasks` | ✅ eskalasi, tidak ada alokasi ganda, batal+refund seimbang |
| Berat aktual berubah | "QC berat kurang/lebih" | ✅ kurang → refund otomatis (ledger seimbang); lebih → PENDING_CUSTOMER; decline → kemas ulang; approve → pembayaran tambahan tercatat |
| QC/packing gagal → tidak bisa pickup | complete-packing 409 tanpa paket/label; pickup 409 tanpa scan | ✅ |
| Label & scan | print/reprint, UNKNOWN_CODE, ROLE_NOT_ALLOWED, DUPLICATE_SCAN | ✅ (pembacaan pada perangkat nyata: belum — butuh perangkat Erza) |
| Konfirmasi < 24 jam → 1 payment task | "konfirmasi sesuai sebelum tenggat" | ✅ tepat satu; konfirmasi ganda 409 |
| Timeout & konfirmasi bersamaan | settlement_key UNIQUE + ON CONFLICT; payouts.idempotency_key | ✅ (unit: 1 payout per key) |
| Aplikasi ditutup/server restart | tenggat di DB (`confirmation_due_at`), job dari scheduler eksternal | ✅ job idempotent (`auto` kedua = 0) |
| Tidak ada konfirmasi > 24 jam | "auto-confirm setelah tenggat"; "foto tanpa OTP → eskalasi" | ✅ |
| Komplain sebelum jatuh tempo | partial accept menahan; tiket COMPLAINT menahan hold | ✅ |
| Webhook palsu/duplikat/terlambat | "webhook pembayaran" | ✅ 401 / duplicate / IGNORED_STATUS_PAID |
| Payout timeout/failed/reversed | provider NONE 409; MOCK PROCESSING→inquiry→PAID; proses ganda 409; reversal jurnal pembalik | ✅ |
| Refund/chargeback setelah payout | reversal + eskalasi PAYOUT_FAILED | ✅ (kebijakan recovery = keputusan bisnis) |
| Akses lintas mitra | task 403, label 403, tiket 403, scan NOT_YOUR_PACKAGE | ✅ |
| Jaringan buruk/offline | SW cache GET; mutasi tidak di-cache; status final server | ✅ desain; uji perangkat belum |
| Backup/restore & rollback | migrasi aditif; Neon branch/pg_dump (runbook) | ⚠ prosedur ditulis, **belum dibuktikan** di lingkungan uji |
| Model dagang RESELLER | "kategori RESELLER" | ✅ harga ×1,2, fee 0, ledger payable=harga beli, margin, pembatalan seimbang |

**UI (Playwright, lokal):** smoke 120 halaman × 4 lebar (360/390/768/1440) tanpa error konsol/overflow (`docs/screenshots-v2/smoke-report.json`); journey 20 langkah lintas peran (katalog → keranjang → checkout → bayar → terima → picking → QC+foto → packing → label QR/Code128 → cetak tercatat → dispatch → scan pickup → OTP serah terima → countdown konfirmasi → terima → payment task → maker → checker → dibayar) **20/20 lolos** (`journey_*.png`).

**Produksi (4 Okt 2026, diverifikasi lewat browser):** API `GET /api/health` ok, `GET /api/public/stats` (endpoint v2 → migrasi 0004/0005 terpasang), login admin OWNER, dashboard Operasional, Staf, Konfigurasi, serta endpoint `admin/ops-dashboard`, `jobs/runs`, `admin/roles`, `admin/users`, `finance/payment-tasks`, `admin/escalations`, `tickets`, `dispatch/ready`, `admin/categories` semua 200. Env `JOB_SECRET` + `PAYMENT_WEBHOOK_SECRET` terpasang di Vercel; `POST /api/jobs/run` tanpa secret ditolak; GitHub Actions `jobs-cron.yml` (secret repo `JOB_SECRET`) berjalan sukses dan tercatat di `job_runs` ("Job terakhir … cron" pada dashboard ops).

**Android (4 Okt 2026):** workflow `android.yml` run #37160140697 (commit `ff1bab1`) **BUILD SUCCESSFUL** setelah dua perbaikan CI (paket SDK eksplisit tanpa `tools` usang; Java 21 untuk Capacitor 8). Artefak: `supplier-id-app-debug-apk` (3,9 MB) dan `supplier-id-app-release-aab-unsigned` (3,0 MB) — unduh dari tab Actions repo `erzamadana-ui/supplier-id`. **Belum dibuktikan:** instalasi & uji di perangkat Android nyata (kamera scan, deep link `https://antarkitaindonesia.com/supplier-id/*`), penandatanganan AAB untuk Play Store.

**Belum/blocker jujur:** uji APK di perangkat nyata; push notification butuh Firebase (token tersimpan, pengiriman belum); pembacaan barcode di printer/scanner nyata; backup/restore belum dibuktikan; payment gateway & payout provider nyata belum ada (sandbox/manual); UAT dengan dataset & mitra nyata belum; staf ops/finance/kurir produksi belum dibuat (hanya akun OWNER).

## Pemetaan Definition of Done v1 (bagian W)

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

## Inspeksi produksi (4 Okt 2026, https://antarkitaindonesia.com/supplier-id + https://supplier-api.antarkitaindonesia.com)

**API (skrip otomatis dari browser, 33/33 lolos):** health; login admin; akun demo tidak ada; mode unggah `direct`; fee 15%; 6 kategori; registrasi supplier & buyer; publish ditolak tanpa foto; 3 foto tersimpan di Supabase Storage & dapat diakses publik; publish READY_FOR_ORDER; listing publik; preview fee 15% & total = Σ komponen; RFQ → quote → counter → accept → order DRAFT; pembatalan setelah bayar → refund; snapshot terkunci saat konfirmasi; bayar (mock); tiba menunggu inspeksi; klaim tanpa bukti ditolak; partial accept → return case EVIDENCE_REVIEW; evidence comparison 3 kolom; adjustment prorata 10%; retur CLOSED; order SETTLED; rekonsiliasi order seimbang; dashboard supplier pending>0; payout PAID; override fee supplier 12% (order lama tetap 15%); quality score terhitung; rekonsiliasi global seimbang; dashboard monetisasi; buyer dilarang akses admin.

**UI (klik manual di Chrome, akun UJI):** daftar supplier → tambah produk → daftarkan batch → unggah 3 foto (langsung ke Storage) → lengkapi atribut → setujui deklarasi → terpublikasi; daftar buyer → marketplace menampilkan listing → order summary transparan (Rp1.803.380 = Σ komponen) → konfirmasi (snapshot) → bayar; supplier packing → pickup (cold chain) → event tracking suhu → tiba; buyer inspeksi "diterima sebagian" 90/100 KG dengan foto + video → RET dibuat dengan eligibility check & perbandingan 3 kolom; admin keputusan Disetujui/atribusi SUPPLIER → refund Rp142.755, potongan supplier Rp148.953 (termasuk logistik retur Rp28.953) → pickup retur → supplier terima → CLOSED/SETTLED → payout Rp1.051.047 PAID; Ledger seimbang (variance Rp0); halaman Monetization, Fees, Tax, Konfigurasi, Supplier & Quality Score, Akun terbuka tanpa error console.

**Temuan & perbaikan dari inspeksi UI:** (1) halaman detail order/retur/listing kosong ("Memuat…") saat refetch sehingga isian form inspeksi hilang setelah unggah bukti → konten kini tetap tampil saat refetch; (2) atribut kategori yang sama dengan kolom batch (kesegaran, ukuran, warna, tanggal panen) harus diisi dua kali → kini otomatis diisi dari kolom batch (server) dan tidak ditanyakan ulang di form; (3) tautan "Akun & kata sandi" bertumpuk dengan tombol Keluar → diperbaiki; (4) label atribut di perbandingan bukti retur tampil sebagai kunci mentah → kini memakai label skema kategori.

## Asumsi & keterbatasan data (dicantumkan agar tidak hilang saat dokumen beredar)

1. **Pajak**: tarif/kelas PPN default adalah asumsi teknis (PPN 11% jasa platform; barang kebutuhan pokok dibebaskan; supplier non-PKP tidak memungut; payment fee pass-through). Belum divalidasi Finance/konsultan pajak. Semua dapat diubah dari Admin → Tax Engine (termasuk `dpp_factor` 11/12).
2. **Payment gateway & kurir**: mock instan. Biaya provider gateway (`payment.provider_fee_*`) dan biaya logistik (`logistics.cost_ratio`) adalah parameter estimasi, bukan tagihan nyata.
3. **Kebijakan refund** (`return.policy`) adalah usulan default: kesalahan SUPPLIER/PACKAGING → supplier menanggung produk & return logistics; LOGISTICS → platform klaim ke penyedia logistik (piutang), supplier tetap dibayar; BUYER_RECEIVING → tanpa refund; OTHER/UNDETERMINED → platform menanggung. Ini keputusan bisnis yang perlu ditetapkan GM/Legal.
4. **Quality Score**: bobot & ambang enforcement default (return rate >10/15/20/30/40%) belum dikalibrasi dengan data nyata; `min_orders=3` agar demo terlihat — di produksi sebaiknya ≥10.
5. Foto/video disimpan di Supabase Storage (produksi) / disk lokal (dev) tanpa deteksi stock-image otomatis (hanya deklarasi supplier + hash + timestamp); verifikasi visual tetap manusia.
6. Belum ada notifikasi push/email/WA; reminder pre-harvest tersedia sebagai endpoint & alert di dashboard supplier.

## Keputusan yang masih diperlukan dari GM

- Tarif nyata: packaging/kg, logistik (dasar, per km, per kg), payment fee ke buyer vs biaya provider, jendela klaim (default 24 jam).
- Matriks refund per atribusi penyebab dan siapa menanggung return logistics.
- Perlakuan PPN per komponen & status PKP Supplier.id (validasi Finance).
- Provider pembayaran (Finpay/Midtrans) dan mitra logistik/cold chain untuk mengganti mock.
