# Release Notes — Supplier-ID v2.1 (8 Okt 2026) — perbaikan hasil inspeksi serah terima produksi

Sumber: inspeksi end-to-end di produksi dengan akun `UJI-*` (lihat `docs/INSPEKSI-PRODUKSI-2026-10-08.md`). Semua perbaikan diuji otomatis (`tests/e2e/v2-fixes.test.ts`, total 49 test lolos).

## Diperbaiki (P1)
- **Scan QR label**: payload QR `SID:PKG:<no>` (dan tautan publik `/p/<no>`) kini diterima `/api/scan` — sebelumnya `UNKNOWN_CODE`, sehingga kamera kurir selalu gagal dan hanya ketik manual yang jalan.
- **Order macet sebelum pickup**: `POST /courier/shipments/:id/events` sekarang ditolak (409 `SHIPMENT_NOT_IN_DELIVERY`) bila shipment belum `PICKED_UP`; sebelumnya event ini diam-diam memindahkan paket ke `IN_TRANSIT` sehingga pickup selamanya `PACKAGES_NOT_SCANNED`. Scan `PICKUP` hanya saat manifest `SCHEDULED`, scan `DELIVER` hanya setelah pickup (`ILLEGAL_SHIPMENT_STATE_*`).
- **Payout mitra buntu**: payment task yang dibuat saat rekening mitra belum ada (`ON_HOLD`, `bank_snapshot` NULL) kini memuat ulang snapshot rekening saat `/release` dan `/submit`; rekening belum diverifikasi ops → 409 `BANK_ACCOUNT_UNVERIFIED`; `/release` juga menolak bila tiket COMPLAINT masih terbuka.
- **Service worker (sid-v2-4)**: GET API **network-first** (cache hanya fallback offline) — data lama tidak lagi tampil setelah aksi (task baru, "job terakhir"); cache dipisah per akun (sidik jari Authorization) dan **dibuang saat login/logout** sehingga ganti akun di perangkat yang sama tidak menampilkan panel/data akun sebelumnya.

## Diperbaiki (P2/P3)
- Pembatalan order kini membatalkan shipment aktif (status baru `CANCELLED`, migrasi 0006) dan semua paket; kurir mendapat notifikasi; tidak tersisa di manifest/dispatch.
- Semua nilai uang dibulatkan ke **rupiah penuh** (sebelumnya total seperti Rp1.289.052,9).
- Detail listing publik hanya menampilkan foto deklarasi batch/panen; foto QC milik order tidak lagi bocor ke katalog.
- Setting baru `supplier.require_verified_to_publish` (default **false**, [USULAN: true] — keputusan GM): mitra harus diverifikasi admin sebelum batch dapat ditayangkan (`SUPPLIER_NOT_VERIFIED`). Tersedia di Admin → Konfigurasi → Fulfillment & Payout → Mitra.

## Catatan operasional
- Cron GitHub Actions `*/10` **tidak andal**: hanya 19 run sejak 4 Okt dengan jeda 4–6 jam (bukti `GET /api/jobs/runs`). Jendela bayar 2 jam & auto-confirm 24 jam bergantung padanya → pakai pinger eksternal (mis. cron-job.org, tiap 5 menit, `POST /api/jobs/run` + header `x-job-secret`) atau Vercel Cron (Pro). Lihat RUNBOOK.

# Release Notes — Supplier-ID v2.0 (4 Okt 2026)

Commit API/web: `684b370` (repo `erzamadana-ui/supplier-id`); web build: `19f9f3c` (repo `erzamadana-ui/antarkita-landing`, folder `supplier-id/`).
Live: web https://antarkitaindonesia.com/supplier-id/ · API https://supplier-api.antarkitaindonesia.com · APK/AAB: artefak GitHub Actions run #37160140697.

## Baru
- **Landing publik & katalog** (tamu): proposisi, kategori, cara belanja, kebijakan, kontak, pendaftaran mitra; pencarian/filter; detail produk dengan foto deklarasi; pelacakan paket publik `/p/:no`.
- **Pelanggan B2C + B2B**: daftar sebagai individu/bisnis, alamat, keranjang lintas mitra, checkout → **order induk** + suborder per batch, bayar saat checkout (sandbox), timeline, OTP serah terima, **jendela konfirmasi 24 jam** (auto-confirm sesuai syarat), keputusan selisih berat, klaim, tiket CS.
- **Mitra (web/PWA)**: task inbox bertahap (terima/tolak → picking/produksi → QC & timbang → packing & label → serah ke kurir) dengan auto-navigasi ke tahap berikutnya; min order, lead time, cutoff, lot per batch; rekening bank & payment task.
- **Label** QR + Code 128 (A4 100×70 mm / thermal 72 mm), cetak tercatat, reprint wajib alasan (versi++), scan divalidasi server (OK/REJECTED + alasan).
- **Kurir (PWA)**: manifest, scan pickup/serah, OTP penerima, foto bukti, gagal antar/kirim ulang, kamera `BarcodeDetector` + input manual.
- **Admin**: peran granular (OWNER/OPS/QC/WAREHOUSE/DISPATCHER/CS/FINANCE_MAKER/FINANCE_CHECKER/AUDITOR, izin ditegakkan server), dashboard Operasional, eskalasi, dispatch & verifikasi bukti, **payment task maker/checker** (idempotent, provider adapter NONE/MOCK, inquiry, reversal, ledger seimbang), tiket, staf, kategori dengan **model dagang hibrida** (MARKETPLACE fee 15% / RESELLER markup), tab Konfigurasi "Fulfillment & Payout (v2)".
- **Keandalan**: job terjadwal idempotent (`/api/jobs/run`, cron GitHub Actions 10 menit), webhook HMAC + dedup, rate limit auth, token_version (cabut sesi), audit log, PWA offline (GET cache, mutasi tidak pernah di-cache).
- **Android**: wrapper Capacitor 8 (`id.supplierid.app`), App Links, kamera; dibangun otomatis di GitHub Actions (APK debug + AAB unsigned).

## Diubah
- Status order: + PROCESSING, READY_FOR_PICKUP, DELIVERY_FAILED; shipment + DELIVERY_FAILED/RETURNED; payment + EXPIRED; payout + PROCESSING/REVERSED/CANCELLED.
- Harga per kategori mengikuti model dagang; ledger baru `RESELLER_MARGIN_REVENUE`, `RESELLER_MARGIN`, `PAYOUT_REVERSAL`.
- Service worker: index.html network-first (rilis baru langsung terpakai), aset ber-hash cache-first.

## Migrasi
`0004_v2_enums.sql`, `0005_v2_core.sql` — aditif (tabel/kolom/enum baru + setting default), dijalankan otomatis saat cold start. Rollback kode aman tanpa rollback skema.

## Keterbatasan yang diketahui (jujur)
Lihat `LAPORAN-UJI.md` bagian "Belum/blocker jujur" dan `AUDIT-GAP-V2.md` §4: APK belum diuji di perangkat nyata; push notification belum terkirim (butuh Firebase); payment gateway & payout provider nyata belum terpasang; backup/restore belum dibuktikan; Vercel Hobby bukan untuk komersial; staf produksi belum dibuat.
