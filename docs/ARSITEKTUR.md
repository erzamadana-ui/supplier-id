# Arsitektur Supplier.id (v1)

## 1. Gambaran

```
Web (React/Vite)  ──HTTP JSON──▶  API (Express/TS)  ──pg──▶  PostgreSQL 16
  Portal Supplier                  routes/                    migrations/0001_init.sql (skema)
  Portal Buyer                     services/ (pricing, ledger, adjustment, quality, returns, config)
  Admin Panel                      uploads/ (bukti foto/video, disajikan di /uploads)
```

Semua logika bisnis ada di API; frontend hanya menampilkan dan memanggil endpoint (`docs/API.md`). Uang disimpan `NUMERIC(18,2)` (Rupiah), persentase `NUMERIC(7,4)`.

## 2. Quality control: self declaration at source (bagian A–D)

- `categories.attribute_schema` (JSONB) mendefinisikan field kualitas dinamis per kategori (TELUR: size, shell_condition, grade, production_date; SAYUR: freshness, size, color, harvest_date, defect_tolerance_pct; DAGING: cut, weight_per_pack_kg, storage_temperature_c, slaughter_date, state; IKAN: species, weight_per_fish_kg, state, catch_date, temperature_c; BUAH; BERAS). Admin dapat mengubah skema tanpa migrasi.
- `batches` = unit deklarasi (READY_STOCK atau HARVEST) dengan grade, kuantitas, berat, tanggal, kondisi, atribut dinamis, harga. `harvests` menyimpan siklus UPCOMING → PRE_HARVEST_UPDATED → FINAL (expected vs actual → dipakai metrik *declaration accuracy*).
- `evidence_files` menyimpan foto/video dengan `owner_type`, `kind`, `supplier_id/buyer_id/product_id/batch_id/harvest_id/order_id/...`, `taken_at`, `uploaded_at`, `sha256`, lokasi opsional hanya bila `location_consent=true`; constraint DB `is_stock_image = FALSE`.
- Publikasi (`POST /supplier/batches/:id/publish`) memvalidasi *readiness* (field wajib, atribut wajib kategori, minimum foto & jenis foto dari `settings.evidence.*`) lalu mencatat `declaration_acceptances` (versi deklarasi, waktu, IP, user-agent, snapshot data yang dideklarasikan).

## 3. Transaksi (bagian V)

RFQ → quotation (round, counter-offer, accept) → order DRAFT (harga final) → **confirm** (pricing snapshot terkunci, stok dikurangi) → **pay** (mock gateway) → **pack** → **pickup** (shipment) → tracking events → **arrive** (ARRIVED_WAITING_INSPECTION) → **inspection** (ACCEPT / PARTIAL_ACCEPT / REJECT) → return case → dispute → keputusan admin → financial adjustment → return logistics → CLOSED → SETTLED → payout.
State machine di `services/orders.ts` (`ALLOWED`), setiap transisi tercatat di `order_events`.

## 4. Pricing engine (bagian K–N, R, S)

`services/pricing.ts::computePricing` (fungsi murni, diuji unit) memisahkan: PRODUCT VALUE, PLATFORM FEE (rate dari `fee_configs`), PACKAGING (tarif/kg), LOGISTICS (dasar + per km + per kg), OPTIONAL SERVICES, DISCOUNT (promo), TAX (per komponen), PAYMENT FEE (persen/tetap atas nilai yang dibayar), TOTAL. Juga menghasilkan `costBasis` (biaya packaging, biaya logistik ke penyedia, biaya provider gateway) untuk ledger.

**Resolusi platform fee** (`services/config.ts::resolvePlatformFee`): baris `fee_configs` yang ACTIVE dan berlaku pada waktu order dikonfirmasi; prioritas override CONTRACT > PROMOTION > BUYER > SUPPLIER > CATEGORY > REGION > VALUE_TIER > GLOBAL. Fee baru punya `effective_from/to`, `previous_value`, `reason`, `created_by`, `approved_by` (bila `settings.fee.change_requires_approval=true`) dan audit log. **Tidak ada 15% di kode sumber** — seed memasukkannya sebagai data.

**Snapshot**: saat confirm, seluruh nominal + `fee_config_id` + `pricing_snapshot` (JSONB: tax lines, cost basis, fee config) disimpan pada order. Perubahan konfigurasi setelahnya tidak mengubah order (diuji: DoD 14–16).

## 5. Tax engine

`tax_rules` dipilih per komponen berdasarkan `transaction_type`, `seller_status` (untuk PRODUCT = status supplier; komponen jasa = platform), `buyer_status`, `service_type` (untuk PRODUCT = `tax_class` kategori: STANDARD / BASIC_NEEDS_EXEMPT), prioritas terkecil menang, dengan `rate_percent` dan `dpp_factor` (mis. 11/12). Diskon mengurangi DPP produk. Default (ASUMSI, wajib validasi Finance): PPN 11% pada jasa platform; produk dikenai hanya bila supplier PKP & kategori STANDARD; payment fee pass-through tidak dipungut.

## 6. Ledger double-entry (bagian P, T, W)

Setiap jurnal (`ledger_journals` + `ledger_entries`) wajib seimbang (dicek di `postJournal`). Akun: `CASH`, `LOGISTICS_RECEIVABLE` (aset); `SUPPLIER_PAYABLE`, `REFUND_PAYABLE`, `LOGISTICS_PAYABLE`, `TAX_PAYABLE` (liabilitas); `PLATFORM_FEE_REVENUE`, `PACKAGING_REVENUE`, `LOGISTICS_REVENUE`, `OPTIONAL_SERVICE_REVENUE`, `PAYMENT_FEE_COLLECTED` (pendapatan); `PACKAGING_COST`, `LOGISTICS_COST`, `PAYMENT_PROCESSING_FEE`, `PROMOTION_DISCOUNT`, `RETURN_ADJUSTMENT` (beban). Kolom `component` memberi label lini bisnis sesuai spesifikasi (PRODUCT_VALUE, PLATFORM_FEE_REVENUE, PACKAGING_REVENUE/COST, LOGISTICS_REVENUE/PAYABLE, PAYMENT_PROCESSING_FEE, TAX_PAYABLE, REFUND, RETURN_ADJUSTMENT, SUPPLIER_PAYABLE, SUPPLIER_PAYOUT, PROMOTION_DISCOUNT, …).

Jurnal per peristiwa: BUYER_PAYMENT (kas masuk; hak supplier; pendapatan; pajak; diskon), PROVIDER_FEE, PACKAGING_COST, LOGISTICS_COST, RETURN_ADJUSTMENT, REFUND_PAID, CANCELLATION, SUPPLIER_PAYOUT.

Rekonsiliasi (`services/ledger.ts::reconcile`): **Money In + Receivables = Money Out + Liability + Tax + Net Revenue**, variance harus 0 dan tidak boleh ada jurnal tidak seimbang.

## 7. Retur, dispute, financial adjustment (bagian E–I, T)

- Inspeksi buyer wajib foto + video (`owner_type=INSPECTION`) untuk klaim; `return_cases` dibuat untuk kuantitas ditolak (partial return didukung: 1.000 → 920/80).
- `runEligibilityCheck` (otomatis) hanya memeriksa kelengkapan bukti, jendela klaim, kuantitas, reason code — **tidak** menyimpulkan siapa yang salah.
- `evidenceComparison` menyusun BEFORE DELIVERY (deklarasi + foto supplier) → DELIVERY (pickup, rute, durasi, event, suhu, kemasan) → AT RECEIVING (foto/video buyer, timestamp, kerusakan, kuantitas) plus *signals* (indikasi, bukan keputusan).
- Keputusan admin (`/returns/:id/decide`) menetapkan `fault_attribution` ∈ {SUPPLIER, PACKAGING, LOGISTICS, BUYER_RECEIVING, OTHER, UNDETERMINED}; `computeAdjustment` memakai `settings.return.policy` (matriks komponen × atribusi: FULL/PRORATA/NONE, `product_loss_bearer`, `return_logistics_bearer`) → refund buyer, potongan supplier, beban platform, piutang klaim logistik, pembalikan pajak, alokasi biaya return logistics → jurnal + `financial_adjustments`.

## 8. Quality Score (bagian J)

`services/quality.ts`: metrik dari data transaksi (successful orders, return rate — tidak menghitung retur yang terbukti kesalahan logistik/buyer, damage rate, quality mismatch, weight mismatch, late fulfillment vs `promised_pickup_at`, cancellation, buyer acceptance rate (kuantitas), dispute rate, declaration accuracy dari panen). Bobot `settings.quality.weights`; enforcement bertingkat `settings.quality.enforcement` (WARNING → RANK_DOWN → VERIFICATION_REQUIRED → LISTING_LIMITED → UNDER_REVIEW) mengubah `organizations.status` dengan audit; listing publik dan RFQ menghormati status tersebut.

## 9. Keamanan & privasi

JWT (7 hari) + bcrypt; otorisasi per peran dan kepemilikan organisasi di setiap endpoint; lokasi foto hanya bila ada persetujuan; IP/user-agent acceptance disimpan sesuai kebijakan privasi; semua perubahan konfigurasi & status supplier tercatat di `config_audit_logs`.

## 10. Yang sengaja masih sederhana (MVP)

Payment gateway & kurir mock; upload disimpan di disk lokal (ganti ke S3/GCS via `UPLOAD_DIR`/adaptor); tanpa pagination; notifikasi (email/WA) belum ada — reminder pre-harvest tersedia sebagai endpoint & alert dashboard; belum ada multi-admin RBAC granular (Finance vs Ops) selain akun admin terpisah untuk dual control.
