# Runbook Operasi Supplier-ID v2

## Lingkungan
- Web: GitHub Pages (`erzamadana-ui/antarkita-landing`, folder `supplier-id/`). Deploy = salin `web/dist` (build `VITE_BASE=/supplier-id/ VITE_API_URL=https://supplier-api.antarkitaindonesia.com`) → push. **Jangan hapus aset build lama** (index.html lama di cache CDN ±10 menit).
- API: Vercel (`erzamadana-ui/supplier-id`, root `server/`). Push ke `main` → auto-deploy; migrasi berjalan saat cold start (`api/index.ts`). Rollback = "Promote" deployment sebelumnya di Vercel; migrasi bersifat aditif (kolom/tabel baru), sehingga rollback kode aman tanpa rollback skema.
- DB: Neon (branching tersedia untuk backup/restore uji: buat branch dari point-in-time → arahkan `DATABASE_URL` preview). Backup logis: `pg_dump "$DATABASE_URL" > backup.sql`; restore: `psql "$DATABASE_URL_BARU" < backup.sql`.
- Storage: Supabase bucket `supplierid-evidence` (publik; URL = bukti). Purge data uji menghapus objek terkait.
- Env Vercel wajib: `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`, `SEED_DEMO=false`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, **`JOB_SECRET`** (cron), **`PAYMENT_WEBHOOK_SECRET`** (webhook gateway). Tidak ada rahasia di frontend/APK/log.

## Job terjadwal (durable)
Endpoint `POST /api/jobs/run` (header `x-job-secret`) idempotent; dipanggil GitHub Actions `jobs-cron.yml` tiap 10 menit (secret repo `JOB_SECRET`). Memproses: pembayaran kedaluwarsa (lepas stok), task terlambat (LATE + eskalasi), jendela konfirmasi berakhir (auto-confirm sesuai syarat / eskalasi), inquiry payout PROCESSING. Riwayat: `GET /api/jobs/runs` (Admin → Operasional "Job terakhir"). Jika job tidak berjalan >30 menit → cek Actions; jalankan manual lewat tombol di dashboard ops (admin dengan `orders.manage`).

**Temuan 8 Okt 2026:** jadwal GitHub Actions `*/10` pada repo ini nyatanya berjalan hanya ±5×/hari (jeda 4–6 jam) — GitHub tidak menjamin jadwal cron, terutama repo tanpa aktivitas. Karena jendela bayar 2 jam, task terlambat, dan auto-confirm 24 jam bergantung pada job ini, pasang **pinger eksternal** sebagai sumber utama: cron-job.org (gratis) → job baru, URL `https://supplier-api.antarkitaindonesia.com/api/jobs/run`, metode `POST`, header `x-job-secret: <JOB_SECRET Vercel>`, interval 5 menit, notifikasi bila gagal. Biarkan workflow Actions tetap aktif sebagai cadangan (job idempotent, aman dipanggil ganda). Verifikasi: `GET /api/jobs/runs` harus bertambah tiap ≤10 menit.

## Prosedur harian ops
1. Admin → Operasional hari ini: task terlambat, QC gagal, gagal antar, tiket, konfirmasi jatuh tempo, rekonsiliasi.
2. Eskalasi: `SUPPLIER_REJECTED/NO_RESPONSE/SUPPLIER_LATE` → batal+refund (atau hubungi mitra), `EVIDENCE_INVALID` → verifikasi foto kurir di Dispatch, `CONFIRMATION_OVERDUE` → hubungi pelanggan → ops-confirm, `DELIVERY_FAILED` → kirim ulang/batal, `WEIGHT_VARIANCE` → menunggu pelanggan, `PAYOUT_FAILED` → finance.
3. Dispatch: tugaskan kurir untuk order READY_FOR_PICKUP (OTP otomatis ke pelanggan).
4. Finance: payment task CREATED → maker ajukan → checker setujui → (provider NONE) transfer bank manual → checker "Catat dibayar" dengan ref bank; (provider MOCK/nyata) prosesor "Proses transfer" → inquiry → PAID. Reversal bila bank mengembalikan dana.

## Insiden & pemulihan
- Payout timeout: status tetap PROCESSING; **jangan** transfer ulang; tekan Inquiry / tunggu job. Idempotency key = settlement_key (UNIQUE) mencegah transfer ganda.
- Webhook palsu/duplikat: ditolak (401) / diabaikan (`webhook_events`).
- Rekonsiliasi tidak seimbang: Admin → Ledger: jurnal tidak seimbang dilaporkan per jurnal; koreksi hanya lewat entri pembalik (manual journal belum ada UI; gunakan SQL dengan audit).
- Sesi dicabut: ganti kata sandi / nonaktifkan user menaikkan `token_version`.
- Purge data uji: Admin → Konfigurasi → Data uji (hanya org "UJI …"/email `uji-*@supplier.id`).

## Rilis
1. `cd server && npm test` (46 test) → 2. `cd web && npx tsc --noEmit && build` → 3. smoke Playwright (`docs/screenshots-v2`) → 4. push API → tunggu Vercel Ready → `GET /api/health` → 5. push web → cek `https://antarkitaindonesia.com/supplier-id/` → 6. catat di `LAPORAN-UJI.md`.
Android: Actions `android.yml` → unduh artifact `app-debug.apk` (uji) / `app-release.aab` (unsigned; tanda tangani di mesin pemilik).
