# Inspeksi Serah Terima Produksi — Supplier-ID v2 (8 Okt 2026, 07.50–09.40 WIB)

Lingkungan: web https://antarkitaindonesia.com/supplier-id/ (GitHub Pages) + API https://supplier-api.antarkitaindonesia.com (Vercel Hobby, DB Neon). Metode: alur bisnis dijalankan end-to-end **di produksi** dengan akun uji `UJI-*` / `uji-*@supplier.id` (dibuat lewat API publik & Admin → Staf), pembayaran sandbox; pengecekan UI lewat Chrome (task inbox mitra, label, manifest kurir, landing, katalog, admin ops). Label: **P1** = proses nyata macet/risiko uang-keamanan, **P2** = salah tapi ada jalan lain, **P3** = kosmetik/kebersihan.

## 1. Prioritas — hasil inspeksi

| # | Alur | Hasil |
|---|---|---|
| 1 | Daftar mitra → produk → batch → 3 foto (Supabase Storage) → publikasi | ✅ berjalan (lihat P1-5: tanpa verifikasi admin) |
| 2 | Katalog publik, stats, keranjang (min order, stok), alamat, preview, checkout (reservasi stok atomik), bayar sandbox | ✅ `SO-2026-000004` & `000005`; checkout tanpa setuju kebijakan auto-confirm ditolak |
| 3 | Task inbox mitra: ACCEPTANCE → PICKING → QC (berat aktual) → PACKING → HANDOVER | ✅ termasuk QC 33 kg vs 30 (10% > toleransi 2%) → `PENDING_CUSTOMER` → resto setuju → tambahan Rp135.000 tercatat |
| 4 | Paket, label QR + Code128 (A4), cetak tercatat, reprint wajib alasan, QR publik `/p/<no>` | ✅ data & tampilan label benar (dicek visual) — **tetapi QR tidak bisa dipindai** (P1-1) |
| 5 | Dispatch → kurir scan PICKUP → pickup → checkpoint suhu → scan DELIVER → OTP salah / tanpa bukti ditolak → OTP benar → jendela konfirmasi 24 jam | ✅ pada order 2 (urutan benar); **order 1 macet** karena P1-2 → dibatalkan admin (refund penuh, stok kembali, ledger seimbang) |
| 6 | Konfirmasi pelanggan (ACCEPT) → SETTLED → payment task → maker/checker → transfer manual (provider NONE) → PAID → tampil di portal mitra | ✅ setelah perbaikan P1-3 dideploy; sebelumnya buntu `BANK_ACCOUNT_MISSING` |
| 7 | RBAC: maker ≠ checker, maker tidak bisa mark-paid, kurir tidak bisa admin, maker tidak bisa dispatch | ✅ semua 403/409 sesuai |
| 8 | Rekonsiliasi per order & global | ✅ seimbang, variance Rp0 (termasuk setelah pembatalan & pembayaran tambahan) |
| 9 | Job terjadwal | ⚠ berjalan & tercatat, tetapi hanya 19 run sejak 4 Okt (jeda 4–6 jam, bukan 10 menit) |

### Defect yang ditemukan dan status perbaikan

| ID | Prioritas | Temuan (bukti) | Perbaikan | Status |
|---|---|---|---|---|
| P1-1 | P1 | QR label berisi `SID:PKG:PKG-2026-000001`; `/api/scan` menjawab `UNKNOWN_CODE` untuk string itu — hanya nomor polos diterima → kamera kurir/mitra selalu gagal | `normalizeScanCode()` menerima payload QR, Code128, dan tautan `/p/<no>` | ✅ deploy `a91a98a`, diverifikasi di produksi |
| P1-2 | P1 | `POST /courier/shipments/:id/events` diterima saat shipment masih `SCHEDULED` dan memindahkan paket `PICKED_UP→IN_TRANSIT`; pickup lalu selamanya `PACKAGES_NOT_SCANNED` (order `SO-000004` macet). Scan `DELIVER` juga diterima sebelum pickup | Guard status: events hanya setelah pickup; scan PICKUP hanya saat `SCHEDULED`, DELIVER hanya setelah pickup (`ILLEGAL_SHIPMENT_STATE_*`) | ✅ deploy |
| P1-3 | P1 | Payment task dibuat `ON_HOLD` dengan `bank_snapshot` NULL (rekening belum ada). Setelah mitra mengisi rekening + admin verifikasi, `/submit` tetap `BANK_ACCOUNT_MISSING`; `/release` oleh OWNER justru lolos tanpa cek → payout mitra tidak pernah bisa diajukan | `refreshBankSnapshot()` saat release/submit; rekening belum diverifikasi → `BANK_ACCOUNT_UNVERIFIED`; release juga menolak bila tiket COMPLAINT terbuka | ✅ deploy; payment task `SO-000005` berhasil PAID setelah deploy |
| P1-4 | P1 | Service worker `sid-v2-3` stale-while-revalidate per URL: (a) setelah aksi, GET berikutnya mengembalikan data lama (task QC tidak muncul, dashboard "Job terakhir 4 Okt" padahal 8 Okt); (b) ganti akun di perangkat yang sama → `/auth/me` akun sebelumnya tampil (token mitra membuka panel OWNER) — risiko di perangkat bersama | SW `sid-v2-4`: GET API network-first (cache hanya offline), cache dipisah per sidik jari Authorization, dibuang saat login/logout | ✅ deploy web `3df8edb` (landing) |
| P1-5 | P1 (bisnis) | Mitra baru (`verified=false`) langsung bisa publikasi & dibeli; stats publik "Wilayah layanan" ikut data mitra belum diverifikasi | Setting `supplier.require_verified_to_publish` (Admin → Konfigurasi → Fulfillment & Payout → Mitra). **Default false** agar tidak mengubah perilaku tanpa keputusan GM | ⏳ keputusan GM |
| P2-1 | P2 | Cron GitHub Actions `*/10` nyatanya ±5 run/hari (bukti `GET /api/jobs/runs`: 7 Okt 12:51 → 19:15 → 23:37 UTC). Jendela bayar 2 jam, task terlambat, auto-confirm 24 jam, inquiry payout terlambat 4–6 jam | Pinger eksternal (cron-job.org 5 menit, POST + `x-job-secret`) — RUNBOOK diperbarui | ⏳ Erza (butuh akun) |
| P2-2 | P2 | Pembatalan order tidak membatalkan shipment: `SO-000004` tetap "Jemput" di manifest kurir & dispatch | Shipment aktif → `CANCELLED` (migrasi 0006), paket dibatalkan, notifikasi kurir | ✅ deploy (sisa `SO-000004` lama hilang saat purge data uji) |
| P2-3 | P2 | Total order Rp1.289.052,9 / Rp1.749.650,78 — rupiah pecahan di semua komponen | `money()` membulatkan ke rupiah penuh | ✅ deploy |
| P2-4 | P2 | Scan `PICKUP` kurir diterima dari paket `PACKED` tanpa scan `HANDOVER` mitra | Dibiarkan (mitra tanpa HP tetap bisa serah terima) — [USULAN] jadikan setting bila SOP mewajibkan handover | ⏳ keputusan |
| P3-1 | P3 | Detail listing publik menampilkan foto QC milik order (5 foto, 3 deklarasi) | Filter owner_type deklarasi/panen | ✅ deploy |
| P3-2 | P3 | `GET /packages/undefined/label` → 500 (uuid tidak divalidasi) | belum | ⏳ backlog |
| P3-3 | P3 | Purge data uji menyertakan org sistem "Supplier-ID Delivery" (LOGISTICS) karena kurir uji bernaung di sana; staf uji `uji-*` tidak terhapus | Purge: org LOGISTICS dikecualikan, user `uji-*` ikut dihapus, semua FK ke users dilepas | ✅ deploy `1abc028` |
| P3-4 | P3 | Tambahan bayar selisih berat (Rp135.000) tidak dikenai platform fee/PPN | [USULAN] perlakuan fee pada selisih berat = keputusan Finance | ⏳ keputusan |

Uji otomatis: `server/tests/e2e/v2-fixes.test.ts` (6 skenario) — total **50 test lolos** (`cd server && npm test`). Type-check `tsc` bersih; web dibangun `vite build` (SW `sid-v2-4`).

## 2. Tugas overdue / berisiko
- **Cron tidak andal (P2-1)** — sejak 4 Okt. Dampak nyata: reservasi stok dari pembayaran gagal baru dilepas 4–6 jam; auto-confirm & payout tertunda.
- **Blocker lama masih terbuka** (dari status 4 Okt): revoke PAT GitHub & ganti sandi admin; uji APK di perangkat; staf produksi; payment gateway & payout provider nyata; hosting non-Hobby; backup/restore belum dibuktikan.
- **Akun admin kedua** `asantika2308@gmail.com` (OWNER) ada di Admin → Staf — pastikan memang dibuat Erza; kalau tidak, nonaktifkan.

## 3. PIC & next action
| PIC | Tindakan | Tenggat usulan |
|---|---|---|
| Erza | Putuskan `supplier.require_verified_to_publish` → aktifkan di Admin → Konfigurasi bila ya | 9 Okt |
| Erza | Pasang pinger cron-job.org (5 menit, POST `/api/jobs/run`, header `x-job-secret`) — langkah di RUNBOOK-V2 | 8 Okt |
| Erza | Konfirmasi akun OWNER `asantika2308@gmail.com` | 8 Okt |
| Claude (sesi berikut) | P3-2 validasi uuid; uji ulang alur kurir dengan kamera di APK | setelah APK diuji |
| Erza | Blocker lama #1–#7 (status 4 Okt) | — |

## 4. Keputusan / data yang masih diperlukan
1. Verifikasi mitra wajib sebelum tayang? (usulan: **ya**, risiko penipuan produk segar + uang masuk sebelum mitra dikenal).
2. Scan HANDOVER mitra wajib sebelum kurir PICKUP? (usulan: tidak wajib, cukup opsional — mitra tanpa HP).
3. Perlakuan platform fee/PPN atas tambahan bayar selisih berat (Finance).
4. Provider payout & gateway nyata (menentukan kapan `payout.provider` ≠ NONE).

## 5. Ringkasan untuk Obsidian
```
## 2026-10-08 — Supplier-ID: inspeksi serah terima produksi v2 → v2.1
- Alur E2E di produksi (akun UJI): mitra→listing→checkout→bayar→task→QC berat→label→dispatch→kurir OTP→konfirmasi→payment task→PAID: LOLOS setelah perbaikan; ledger seimbang.
- 5 defect P1 diperbaiki & dideploy (API a91a98a/1abc028, web 3df8edb): scan QR label, guard status kurir (order macet), snapshot rekening payment task, SW stale/cross-akun, + setting verifikasi mitra (default off, keputusan GM).
- P2: cron Actions hanya ±5 run/hari → pasang cron-job.org; batal order kini membatalkan shipment; rupiah penuh.
- 50 test otomatis lolus. Laporan: docs/INSPEKSI-PRODUKSI-2026-10-08.md; release notes v2.1.
- Keputusan GM: verifikasi mitra wajib?; HANDOVER wajib?; fee atas selisih berat; provider payout.
- Data uji UJI-* di produksi dihapus via Admin → purge (rekonsiliasi tetap seimbang).
```

---
*Keterbatasan data: inspeksi memakai pembayaran sandbox dan transfer manual (provider NONE); kamera scan & deep link diuji lewat API, bukan perangkat Android nyata; angka ledger berasal dari 2 order uji; cron dievaluasi dari 19 catatan `job_runs` (4–8 Okt).*
