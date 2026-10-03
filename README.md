# Supplier-ID — Platform Hasil Tani, Ternak & Laut (v2)

v2 (4 Okt 2026): pelanggan B2C+B2B, task inbox mitra, QC berat aktual, paket/label/scan, kurir + OTP, konfirmasi 24 jam, payment task maker/checker, PWA, Android (Capacitor). Dokumen: `docs/AUDIT-GAP-V2.md`, `KEPUTUSAN-V2.md`, `PRD-V2.md`, `DESIGN-SYSTEM.md`, `RUNBOOK-V2.md`, `LAPORAN-UJI.md`, `API.md`.

Prinsip: **DECLARE → PROVE → DELIVER → INSPECT → EVIDENCE → SETTLE**

Monorepo:

| Folder | Isi |
|---|---|
| `server/` | API Node.js 22 + Express 4 + TypeScript, PostgreSQL 16 (driver `pg`, migrasi SQL murni), Vitest (unit + E2E) |
| `web/` | Frontend React 18 + TypeScript + Vite + react-router (Portal Supplier, Portal Buyer, Admin Panel) |
| `docs/` | `API.md`, `ARSITEKTUR.md`, `LAPORAN-UJI.md`, `PRD-V2.md`, `DESIGN-SYSTEM.md`, `RUNBOOK-V2.md`, `screenshots/`, `screenshots-v2/` |
| `android-app/` | Pembungkus Capacitor (APK/AAB dibangun GitHub Actions `android.yml`) |
| `.github/workflows/` | `android.yml` (APK/AAB), `jobs-cron.yml` (job konfirmasi/payout tiap 10 menit) |
| `docker-compose.yml` | PostgreSQL lokal |

## Menjalankan (lokal)

```bash
# 1) Database — pilih salah satu
docker compose up -d                       # Postgres di localhost:5432 (user/pass: postgres/postgres)
#   atau gunakan Postgres yang sudah ada, lalu: createdb supplier_id; createdb supplier_id_test

# 2) API
cd server && npm install
cp .env.example .env                       # sesuaikan DATABASE_URL bila perlu
npm run dev                                # migrasi + seed otomatis, API di http://localhost:4000

# 3) Web (mode pengembangan, hot reload; proxy /api → 4000)
cd web && npm install && npm run dev       # http://localhost:5173

# Produksi satu proses: build web lalu API menyajikan web/dist
cd web && npm run build && cd ../server && npm start   # http://localhost:4000
```

Data demo lengkap (listing, panen, RFQ, order berbagai status, retur, dispute, payout):

```bash
cd server && node scripts/demo-flow.mjs            # server harus berjalan
```

Akun demo (sandi `Password123`): `admin@supplier.id`, `finance@supplier.id` (approver dual control), `tani@supplier.id`, `ternak@supplier.id` (PKP), `nelayan@supplier.id`, `buyer@supplier.id`, `hotel@supplier.id`.

## Pengujian

```bash
cd server
npm run test:unit    # pricing engine, tax engine, return adjustment (fungsi murni)
npm run test:e2e     # 15 skenario end-to-end terhadap PostgreSQL (database supplier_id_test di-reset otomatis)
npm test             # semuanya (25 test)
```

Lihat `docs/LAPORAN-UJI.md` untuk pemetaan ke 21 butir Definition of Done.

## Konfigurasi tanpa deploy (Admin Panel)

- **Fees & Monetization → Platform Fee**: default 15%, ubah ke 10/12/15/18/…, effective date, previous value, reason, created_by, approval opsional (dual control), audit log. Override per kategori/supplier/buyer/kontrak/promo/nilai transaksi/region sudah didukung skema.
- **Tax Engine**: aturan PPN per komponen (produk, platform fee, packaging, logistik, payment fee, layanan opsional) berdasarkan status PKP penjual/pembeli, kelas pajak kategori, prioritas, `dpp_factor`.
- **Konfigurasi**: tarif packaging & logistik, payment fee, jendela klaim, kebijakan refund per komponen × atribusi penyebab, bobot & ambang Quality Score, layanan opsional, promo, minimum foto bukti.
- **Kategori & Reason Code**: skema atribut kualitas dinamis per kategori; reason code retur.

Semua nilai uang memiliki pricing snapshot per order, jurnal double-entry, dan dapat direkonsiliasi (`Admin → Ledger & Rekonsiliasi`).

## Produksi (live)

| Komponen | Lokasi |
|---|---|
| Web (statis, GitHub Pages) | https://antarkitaindonesia.com/supplier-id/ — repo `erzamadana-ui/antarkita-landing` folder `supplier-id/` (+ `404.html` SPA fallback) |
| API (Vercel serverless, Hobby) | https://supplier-api.antarkitaindonesia.com (alias https://supplier-id.vercel.app) — repo `erzamadana-ui/supplier-id`, root `server/`, entry `api/index.ts` (migrasi + seed otomatis saat cold start) |
| Database | Neon PostgreSQL (Singapore), `DATABASE_URL` dengan `sslmode=require` |
| Foto/video bukti | Supabase Storage bucket `supplierid-evidence` (publik), unggah langsung dari browser via signed URL |

Env Vercel: `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`, `SEED_DEMO=false`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`.
Build web produksi: `cd web && VITE_BASE=/supplier-id/ VITE_API_URL=https://supplier-api.antarkitaindonesia.com npx vite build` → salin `dist/` ke `antarkita-landing/supplier-id/`.
Pendaftaran supplier/buyer self-service di `/supplier-id/register`; ganti kata sandi di `/supplier-id/akun`; hapus data uji di Admin → Konfigurasi → Data uji.

## Catatan penting

- Payment gateway dan logistik masih **mock** (instan, tanpa uang nyata). Integrasi Finpay/Midtrans dan kurir nyata tinggal mengganti adaptor di `routes/orders.ts` (`/pay`) dan `shipments`.
- Nilai default pajak (PPN 11%, produk kebutuhan pokok dibebaskan, jasa platform dipungut) adalah **asumsi** dan wajib divalidasi Finance/konsultan pajak sebelum produksi — semuanya dapat diubah dari Admin Panel.
- Akun demo hanya dibuat bila `SEED_DEMO` ≠ `false`; di produksi hanya admin dari env. Ganti kata sandi admin lewat `/akun` setelah serah terima; `JWT_SECRET` wajib acak.
- Vercel Hobby **bukan untuk penggunaan komersial** menurut ketentuan Vercel — sebelum transaksi nyata, upgrade ke Vercel Pro (atau pindah ke Render/Railway/VPS; kode tidak bergantung pada Vercel kecuali `server/api/index.ts` + `vercel.json`). Cold start ±3–8 detik pada Hobby.
