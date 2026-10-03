# Supplier-ID v2 — Audit Existing vs Spesifikasi Baru (4 Okt 2026)

Dasar fakta: repo `erzamadana-ui/supplier-id` commit `b34961a` (live di https://antarkitaindonesia.com/supplier-id + https://supplier-api.antarkitaindonesia.com), 78 endpoint, 30 tabel, 27 halaman, ±8.000 baris TS/TSX, 27 test otomatis lolus, inspeksi produksi 33/33 (lihat `LAPORAN-UJI.md`). Label: **[FAKTA]** = ada di repo/terverifikasi, **[PARSIAL]**, **[BELUM]**, **[USULAN]** = rancangan yang perlu keputusan, **[ASUMSI]** = nilai sementara.

## 1. Stack & infrastruktur [FAKTA]
| Lapisan | Existing | Catatan v2 |
|---|---|---|
| Backend | Node 22, Express 4, TypeScript, PostgreSQL 16 (`pg`, migrasi SQL versioned `server/migrations/000x_*.sql`) | Dipertahankan; tambah migrasi 0004+ |
| Frontend | React 18 + Vite + react-router, basename `/supplier-id` | Dipertahankan; tambah design system, PWA manifest + service worker |
| Hosting | API: Vercel Hobby serverless (cold start 3–8 dtk, **non-komersial per ToS**); Web: GitHub Pages; DB: Neon free (sleep saat idle); Storage: Supabase (bucket publik) | Job durable (konfirmasi 24 jam, payout) **tidak bisa** bergantung pada proses long-running di serverless Hobby → perlu cron eksternal / Vercel Cron (Pro) / worker terpisah |
| Auth | JWT 7 hari + verifikasi DB (`token_version`), bcrypt; peran `ADMIN`/`SUPPLIER`/`BUYER` | Belum ada MFA, belum ada peran kurir/CS/finance maker-checker/auditor |
| Integrasi | Payment **mock** (instan), kurir **mock**, payout **mock** (`TRF-…` instan `PAID`) | Semua harus gagal jelas bila belum dikonfigurasi (v2) |
| Android | Tidak ada. Toolchain: Java 21 + Gradle 8.14 tersedia di sandbox, **tetapi dl.google.com, maven.google.com, repo1.maven.org, plugins.gradle.org diblokir proxy (403)** — juga dari VM Mac | APK hanya bisa dibangun lewat **GitHub Actions** (runner ubuntu punya Android SDK). Blocker: PAT perlu izin *Workflows* atau Erza yang push file workflow |

## 2. Aset identitas visual [FAKTA — 3 gambar diunggah 4 Okt]
Tidak ada file font, logo vektor, atau file Figma/template Supplier-ID. Tiga gambar referensi (bukan template Supplier-ID):
1. **Dashboard "Portu."** (1566×848) — gaya admin: kartu putih radius besar, bayangan lembut, aksen oranye-salmon, teks ungu-gelap. Warna terukur: latar `#F5F5F6`, teks `#37395E`, aksen `#ED9C7A`, cokelat `#635356`, hijau `#6EAD9B`.
2. **Infografis "England"** (1344×942) — palet editorial: krem `#EDE4D8`, koral `#EB7867`, biru-abu `#5E6A94`, navy `#282445`, salmon muda `#EBAA9C`.
3. **Landing "My Farm"** (1430×802) — hero ilustrasi, headline besar kontras bold/regular, CTA pil beige, nav minimalis. Warna: putih-krem `#FBFAF6`, beige `#E2D6B7`, oranye `#DF9C6C`, hijau `#506B5D`/`#6CA688`, cokelat `#543A23`, kuning `#F1D85B`.

Font pada ketiga referensi **tidak dapat diidentifikasi pasti dari gambar** → [ASUMSI] Poppins (dashboard), Montserrat (infografis), Inter/Roboto (landing). Spacing/radius diukur relatif terhadap lebar gambar (radius kartu ±16–24 px, tombol pil, grid 12 kolom, gutter ±24 px) → [ASUMSI] hingga Erza memberi file Figma/template asli.

## 3. Peta alur existing vs spesifikasi
| Alur | Status | Bukti / gap |
|---|---|---|
| Landing publik | **[BELUM]** | `/supplier-id/` langsung ke login |
| Katalog publik & pencarian | [PARSIAL] | `GET /api/listings` publik, filter kategori/komoditas/wilayah; UI Marketplace hanya setelah login; belum ada halaman katalog tanpa login, SKU/variasi, min. order, slot/cutoff, FEFO |
| Keranjang multi-item/multi-mitra | **[BELUM]** | Order = 1 batch, 1 supplier (`orders.batch_id`), tanpa order induk/suborder |
| Checkout & pembayaran pelanggan | [PARSIAL] | DRAFT → confirm (snapshot harga + reservasi stok `FOR UPDATE`, atomik) → `/pay` mock VA. Belum: alamat tersimpan, pembayaran nyata, kedaluwarsa pembayaran (reservasi tidak dilepas otomatis) |
| Alokasi ke mitra & task inbox | [PARSIAL] | Status order PAID→PACKING→PICKED_UP; halaman "Pesanan" supplier (perlu tindakan/dalam pengiriman). Belum: entitas task (ID, PIC, stage, deadline, prioritas, dependensi, histori), terima/tolak dengan alasan, reassign/eskalasi |
| Produksi/picking → QC → packing → label | [PARSIAL] | QC existing = deklarasi batch pra-jual (foto ≥3) + inspeksi buyer; belum ada QC record per task, timbang berat aktual saat QC, paket/label/barcode, scan |
| Serah-terima kurir → delivery → penerimaan | [PARSIAL] | Shipment + event (checkpoint/suhu/delay) + `arrive`; penerimaan = inspeksi buyer (ACCEPT/PARTIAL/REJECT, foto+video). Belum: peran kurir, OTP/bukti penerimaan tervalidasi, gagal antar, manifest/scan |
| Konfirmasi 24 jam → payment task → payout | [PARSIAL] | SETTLED segera saat inspeksi penuh; payout per supplier dijalankan admin (instan `PAID`, mock). Belum: `delivered_at`/`confirmation_due_at`, auto-confirm per policy, hold saat sengketa, payment task maker/checker, idempotency per settlement, status processing/failed/reversed, rekonsiliasi bank |
| Sengketa/refund | [FAKTA] | Return case + eligibility + perbandingan bukti 3 kolom + keputusan admin + financial adjustment + refund ledger + retur logistik — **dipertahankan** |
| Ledger & rekonsiliasi | [FAKTA] | Double-entry, reconcile global/per-order, entri pembalik (adjustment) — dipertahankan; tambah akun utang mitra per suborder & settlement id |
| Admin | [PARSIAL] | Monetization, fees (dual control), tax, settings, kategori, supplier & quality, order, retur, ledger, payout. Belum: peran granular (owner/ops/QC/gudang/dispatcher/CS/finance maker-checker/auditor), tiket CS, promo budget, dashboard backlog/overdue, monitoring job |
| Keamanan | [PARSIAL] | RBAC server-side per peran + isolasi org (`supplier_id/buyer_id` dicek di tiap endpoint), rate limit **belum**, MFA **belum**, upload hanya image/video |
| PWA/Android/Push | **[BELUM]** | Tidak ada manifest/SW; tidak ada proyek Android; tidak ada push |

## 4. Keputusan bisnis yang menentukan desain (lihat `KEPUTUSAN-V2.md` setelah dikonfirmasi)
1. Model: Supplier-ID **reseller** (jual atas nama sendiri, membeli dari mitra) atau **marketplace** (mitra penjual, Supplier-ID memungut komisi) — menentukan faktur, pajak, siapa pihak dalam transaksi.
2. Segmen pelanggan: B2C (konsumen rumah tangga, benchmark Shopee) **dan/atau** B2B existing (resto/hotel, RFQ, PKP).
3. Kapan pelanggan membayar: saat checkout (default usulan) / COD / tempo B2B.
4. Auto-confirm 24 jam: aktif sejak awal atau eskalasi manual dulu.
5. SLA eksekusi payout setelah task dibuat (usulan: H+1 kerja setelah approval).
6. Komisi/fee: tetap 15% existing (dapat diubah admin) atau skema lain.
7. Printer label yang tersedia (thermal 58/80 mm atau A4) dan siapa mencetak (mitra atau gudang Supplier-ID).
8. Siapa melakukan QC/packing: mitra, gudang Supplier-ID, atau keduanya per kategori.

## 5. Rencana implementasi (urutan) & decision gate
| Milestone | Isi | Gate |
|---|---|---|
| M1 | Audit ini, keputusan bisnis, ERD/state machine | Jawaban butir 4 |
| M2 | Design tokens + komponen; landing publik; katalog publik tanpa login | — |
| M3 | Migrasi 0004–0007: order induk/suborder/keranjang, fulfillment task + events, QC record (berat aktual), package/label/scan, delivery evidence (OTP), confirmation window, payment task maker/checker, peran baru; job durable via endpoint cron ter-otentikasi | Keputusan 3–5 |
| M4 | Web pelanggan (keranjang, checkout, timeline, konfirmasi), PWA mitra (inbox, QC, packing, label, scan), PWA kurir, admin (payment task, tiket CS, tabel operasional) | — |
| M5 | Android (Capacitor) + workflow GitHub Actions untuk APK/AAB | Izin Workflows pada PAT / push oleh Erza |
| M6 | E2E per peran, UAT, label contoh, laporan rekonsiliasi, runbook, GO/NO-GO | — |

GO transaksi produksi tetap **NO-GO** sampai: payment gateway berizin terkonfigurasi, hosting non-Hobby, kebijakan 24 jam & payout diputuskan, review legal/pajak, backup/restore terbukti.
