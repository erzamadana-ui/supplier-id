# PRD Supplier-ID v2 — ringkas, dengan state machine, kamus status, ERD

Tujuan: platform pembelian hasil tani/ternak/laut (B2C + B2B) yang menghubungkan pelanggan dengan mitra petani/peternak/nelayan dan operasi fulfillment Supplier-ID; benchmark kemudahan Shopee; karakter produk segar (berat aktual, kesegaran, cold chain, konfirmasi 24 jam).

## Kanal & peran
| Kanal | Peran | Fungsi inti |
|---|---|---|
| Landing + katalog publik | tamu | proposisi, kategori, cara belanja, kualitas/asal, wilayah, FAQ, kebijakan, pendaftaran mitra; tautan admin terpisah di footer |
| Web & Android pelanggan | BUYER (INDIVIDU/BISNIS) | katalog, pencarian/filter, detail, keranjang, checkout, alamat, bayar, timeline, OTP, konfirmasi 24 jam, keputusan berat, klaim (foto+video), tiket |
| Web/PWA mitra | SUPPLIER | katalog & batch (min order, lead time, cutoff, lot), task inbox (terima/tolak, produksi/picking, QC & timbang, packing & label, serah), rekening, payment task |
| Web/PWA kurir | COURIER | manifest, scan pickup/deliver, tracking suhu/lokasi, OTP/foto, gagal antar, kirim ulang |
| Admin | ADMIN + admin_role (OWNER/OPS/QC/WAREHOUSE/DISPATCHER/CS/FINANCE_MAKER/FINANCE_CHECKER/AUDITOR) | ops dashboard, eskalasi, dispatch, verifikasi bukti, payment task maker/checker, tiket, staf, konfigurasi, kategori (model dagang), ledger |

RBAC di server (`requireRole`, `requirePerm`); isolasi data mitra/pelanggan diperiksa per endpoint (bukan sekadar menyembunyikan tombol). Finance tidak dapat mengubah bukti QC/penerimaan (endpoint QC = SUPPLIER; verifikasi bukti = ops dengan audit).

## State machine
**Order (suborder per batch):** DRAFT → PENDING_PAYMENT → PAID → PROCESSING → PACKING → READY_FOR_PICKUP → PICKED_UP → IN_TRANSIT → ARRIVED_WAITING_INSPECTION → ACCEPTED | PARTIALLY_ACCEPTED | REJECTED → (DISPUTED) → SETTLED; CANCELLED dari DRAFT…READY_FOR_PICKUP/DELIVERY_FAILED; IN_TRANSIT/PICKED_UP → DELIVERY_FAILED → IN_TRANSIT (kirim ulang) | CANCELLED. Tabel `ALLOWED` di `services/orders.ts`.
**Order induk (order_groups):** PENDING_PAYMENT → PAID | EXPIRED | CANCELLED.
**Fulfillment task:** NEW/AWAITING_RESPONSE → IN_PROGRESS → DONE; NEEDS_ACTION (QC gagal, menunggu pelanggan) → IN_PROGRESS/DONE; LATE (job) → IN_PROGRESS/DONE/REJECTED; REJECTED/CANCELLED final. Tahap berikutnya dibuat hanya oleh penyelesaian tahap sebelumnya (`depends_on`). UNIQUE(order_id, stage) mencegah klaim ganda.
**Paket:** PACKED → HANDED_OVER → PICKED_UP → IN_TRANSIT → DELIVERED → RECEIVED; CANCELLED/LOST. Transisi hanya lewat scan yang valid (`scanPackage`): kode asing, paket batal, scan duplikat, peran salah, bukan manifest kurir → REJECTED (tercatat).
**Shipment:** SCHEDULED → PICKED_UP → IN_TRANSIT → ARRIVED (→ DELIVERED/RECEIVED via inspeksi) ; DELIVERY_FAILED → IN_TRANSIT.
**Pembayaran pelanggan:** PENDING → PAID → PARTIALLY_REFUNDED/REFUNDED; EXPIRED; webhook HMAC + dedup (`webhook_events`).
**Konfirmasi:** `delivered_at` hanya dari bukti sah (OTP, atau foto kurir yang diverifikasi ops) → `confirmation_due_at = delivered_at + confirmation.window_hours` (UTC server) → BUYER confirm / AUTO (job; syarat: policy aktif, pelanggan menyetujui di checkout, bukti valid, pembayaran PAID, tanpa return case/hold) / OPS confirm; lewat tenggat tanpa syarat → eskalasi `CONFIRMATION_OVERDUE`, dana tidak dilepas.
**Payment task (per suborder, `settlement_key` UNIQUE):** ON_HOLD ⇄ CREATED → PENDING_APPROVAL → APPROVED → PROCESSING → PAID → REVERSED; REJECTED → CREATED; FAILED → APPROVED (tinjau) | CANCELLED. Maker ≠ checker ≠ (opsional) prosesor. PAID hanya dari provider (sinkron/inquiry) atau bukti bank (manual). Reversal = jurnal pembalik + eskalasi.
**Return case & dispute:** existing v1 (REQUESTED → EVIDENCE_REVIEW → APPROVED/PARTIALLY_APPROVED/REJECTED → PICKUP_SCHEDULED → IN_TRANSIT → RECEIVED_BY_SUPPLIER → CLOSED).
**Tiket:** OPEN → IN_PROGRESS ⇄ WAITING_CUSTOMER → ESCALATED → RESOLVED → CLOSED; tiket COMPLAINT menahan payment task sampai ditutup.

## Kamus status (label UI)
Lihat `web/src/lib/api.ts`: `ORDER_STATUS_LABEL`, `TASK_STAGE_LABEL`, `TASK_STATUS_LABEL`, `PT_STATUS_LABEL`, `PKG_STATUS_LABEL`, `RETURN_STATUS_LABEL`.

## ERD (tambahan v2 di atas 30 tabel v1)
`order_groups 1—n orders`; `orders 1—n fulfillment_tasks 1—n task_events`; `orders 1—n qc_records`; `orders 1—n packages 1—n label_prints / package_scans`; `shipments (courier_user_id, otp_hash, delivery_evidence)`; `orders 1—1 payment_tasks (settlement_key) 1—n payment_task_events; payment_tasks n—1 payouts (idempotency_key)`; `webhook_events`; `job_runs`; `escalations`; `tickets 1—n ticket_messages`; `buyer_addresses`; `cart_items`; `notifications`; `push_tokens`; `users.admin_role/permissions`; `categories.trade_model/reseller_markup_pct`. Diagram penuh: `ARSITEKTUR.md` + migrasi `server/migrations/0005_v2_core.sql` (komentar per kolom).

## Formula uang
- Harga pelanggan (MARKETPLACE): produk + platform fee (15%, konfigurasi) + packaging + ongkir + biaya bayar + layanan opsional − promo + PPN per komponen (tax engine).
- Harga pelanggan (RESELLER): harga mitra × (1+markup) + komponen lain; platform fee 0; margin = pendapatan `RESELLER_MARGIN_REVENUE`.
- Hak mitra bruto: MARKETPLACE = nilai produk; RESELLER = harga beli × kuantitas. Neto = bruto − potongan retur/berat yang menjadi tanggung jawab mitra (ledger `SUPPLIER_PAYABLE`). Ongkir/promo/subsidi mengikuti penanggungnya (platform/pelanggan), tidak mengurangi hak mitra secara implisit.
- Rekonsiliasi: Money In + Piutang = Money Out + Liabilities + Tax + Net Revenue (semua jurnal seimbang; koreksi lewat entri pembalik).

## Keputusan terbuka
Lihat `KEPUTUSAN-V2.md` (bagian [USULAN]) dan `AUDIT-GAP-V2.md` §4.
