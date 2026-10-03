-- v2 (Supplier-ID): peran & izin, model dagang hibrida, keranjang & order induk, fulfillment task, QC, paket/label/scan,
-- bukti penerimaan & jendela konfirmasi 24 jam, payment task maker/checker, webhook, job, eskalasi, tiket CS, notifikasi.
-- Semua kolom baru nullable/default agar data existing tetap valid.

-- ---------------- PERAN & IZIN ----------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role TEXT;             -- OWNER|OPS|QC|WAREHOUSE|DISPATCHER|CS|FINANCE_MAKER|FINANCE_CHECKER|AUDITOR (hanya role ADMIN)
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS buyer_kind TEXT;      -- INDIVIDU | BISNIS
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bank_account_name TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bank_verified_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bank_verified_by UUID REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS service_regions JSONB NOT NULL DEFAULT '[]';

-- ---------------- MODEL DAGANG HIBRIDA (keputusan #1) ----------------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS trade_model TEXT NOT NULL DEFAULT 'MARKETPLACE'; -- MARKETPLACE | RESELLER
ALTER TABLE categories ADD COLUMN IF NOT EXISTS reseller_markup_pct NUMERIC(7,4) NOT NULL DEFAULT 20;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS storage_instructions TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS shelf_life_days_default INT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS complaint_window_hours INT;  -- NULL = ikut setting global

-- ---------------- KATALOG: SKU, min order, mode jual ----------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_instructions TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS min_order_qty NUMERIC(18,3) NOT NULL DEFAULT 1;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS sale_mode TEXT NOT NULL DEFAULT 'READY';          -- READY | PREORDER
ALTER TABLE batches ADD COLUMN IF NOT EXISTS lead_time_days INT NOT NULL DEFAULT 1;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS cutoff_time TEXT;                                   -- 'HH:MM' Asia/Jakarta
ALTER TABLE batches ADD COLUMN IF NOT EXISTS reserved_quantity NUMERIC(18,3) NOT NULL DEFAULT 0; -- reservasi belum dibayar (dilepas saat kedaluwarsa)
ALTER TABLE batches ADD COLUMN IF NOT EXISTS lot_code TEXT;

-- ---------------- ALAMAT PELANGGAN ----------------
CREATE TABLE IF NOT EXISTS buyer_addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id    UUID NOT NULL REFERENCES organizations(id),
  label       TEXT NOT NULL DEFAULT 'Utama',
  recipient   TEXT NOT NULL,
  phone       TEXT NOT NULL,
  address     TEXT NOT NULL,
  city        TEXT,
  province    TEXT,
  postal_code TEXT,
  lat         NUMERIC(10,6), lng NUMERIC(10,6),
  distance_km NUMERIC(10,2) NOT NULL DEFAULT 0,  -- jarak ke hub (diisi pelanggan/ops; belum ada geocoding)
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buyer_addresses_buyer ON buyer_addresses(buyer_id);

-- ---------------- KERANJANG & ORDER INDUK ----------------
CREATE TABLE IF NOT EXISTS cart_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id   UUID NOT NULL REFERENCES organizations(id),
  batch_id   UUID NOT NULL REFERENCES batches(id),
  quantity   NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, batch_id)
);

CREATE TABLE IF NOT EXISTS order_groups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_no         TEXT NOT NULL UNIQUE,
  buyer_id         UUID NOT NULL REFERENCES organizations(id),
  status           TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',  -- PENDING_PAYMENT | PAID | EXPIRED | CANCELLED | COMPLETED
  address_id       UUID REFERENCES buyer_addresses(id),
  delivery_address TEXT,
  total_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  payment_due_at   TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  auto_confirm_notice_accepted_at TIMESTAMPTZ,   -- pelanggan diberitahu kebijakan konfirmasi 24 jam saat checkout
  weight_tolerance_accepted_at    TIMESTAMPTZ,   -- pelanggan menyetujui toleransi berat aktual
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_groups_buyer ON order_groups(buyer_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_group_id UUID REFERENCES order_groups(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS trade_model TEXT NOT NULL DEFAULT 'MARKETPLACE';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS purchase_unit_price NUMERIC(18,2);   -- RESELLER: harga beli dari mitra per satuan
ALTER TABLE orders ADD COLUMN IF NOT EXISTS purchase_value NUMERIC(18,2);        -- RESELLER: hak mitra bruto (harga beli × qty)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_due_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;             -- bukti penerimaan sah (OTP / foto kurir terverifikasi)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_due_at TIMESTAMPTZ;      -- delivered_at + jendela konfirmasi (waktu server)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_evidence_valid BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_by TEXT;                    -- BUYER | AUTO | OPS
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_reason TEXT;                     -- menahan payment task (sengketa/bukti tidak valid/chargeback)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS needs_ops_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS actual_weight_kg NUMERIC(18,3);       -- hasil timbang QC
ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_adjustment JSONB;              -- {status: NONE|WITHIN_TOLERANCE|PENDING_CUSTOMER|APPROVED|DECLINED, expected, actual, tolerance_pct, delta_value}
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_slot TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS orders_group ON orders(order_group_id);
CREATE INDEX IF NOT EXISTS orders_confirmation_due ON orders(confirmation_due_at) WHERE confirmation_due_at IS NOT NULL;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_group_id UUID REFERENCES order_groups(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_event_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT TRUE;  -- mock/sandbox tidak boleh tampak sebagai produksi

-- ---------------- FULFILLMENT TASK (inbox mitra) ----------------
CREATE TABLE IF NOT EXISTS fulfillment_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_no       TEXT NOT NULL UNIQUE,
  order_id      UUID NOT NULL REFERENCES orders(id),
  supplier_id   UUID NOT NULL REFERENCES organizations(id),
  stage         TEXT NOT NULL,   -- ACCEPTANCE | PRODUCTION | PICKING | QC | PACKING | HANDOVER
  status        TEXT NOT NULL DEFAULT 'NEW',  -- NEW | AWAITING_RESPONSE | IN_PROGRESS | NEEDS_ACTION | LATE | DONE | REJECTED | CANCELLED
  assignee_id   UUID REFERENCES users(id),
  quantity      NUMERIC(18,3) NOT NULL,
  unit          TEXT NOT NULL,
  weight_kg     NUMERIC(18,3),
  deadline      TIMESTAMPTZ,
  priority      INT NOT NULL DEFAULT 3,       -- 1 tertinggi
  instructions  TEXT,
  depends_on    UUID REFERENCES fulfillment_tasks(id),
  result        JSONB NOT NULL DEFAULT '{}',
  reason        TEXT,                          -- alasan tolak / pengecualian
  ready_at      TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, stage)                     -- satu task aktif per tahap per suborder (anti klaim ganda)
);
CREATE INDEX IF NOT EXISTS ft_supplier_status ON fulfillment_tasks(supplier_id, status);
CREATE INDEX IF NOT EXISTS ft_deadline ON fulfillment_tasks(deadline);

CREATE TABLE IF NOT EXISTS task_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES fulfillment_tasks(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor_id    UUID REFERENCES users(id),
  note        TEXT,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qc_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID REFERENCES fulfillment_tasks(id),
  order_id              UUID NOT NULL REFERENCES orders(id),
  batch_id              UUID NOT NULL REFERENCES batches(id),
  supplier_id           UUID NOT NULL REFERENCES organizations(id),
  inspector_id          UUID REFERENCES users(id),
  measured_quantity     NUMERIC(18,3),
  measured_weight_kg    NUMERIC(18,3),
  measured_temperature_c NUMERIC(6,2),
  grade                 TEXT,
  passed                BOOLEAN NOT NULL,
  reject_reason         TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qc_order ON qc_records(order_id);

-- ---------------- PAKET, LABEL, SCAN ----------------
CREATE TABLE IF NOT EXISTS packages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_no           TEXT NOT NULL UNIQUE,                 -- PKG-YYYY-nnnnnn (ID internal, bukan GTIN/GS1)
  order_id             UUID NOT NULL REFERENCES orders(id),
  supplier_id          UUID NOT NULL REFERENCES organizations(id),
  batch_id             UUID NOT NULL REFERENCES batches(id),
  shipment_id          UUID REFERENCES shipments(id),
  status               TEXT NOT NULL DEFAULT 'PACKED',       -- PACKED | HANDED_OVER | PICKED_UP | IN_TRANSIT | DELIVERED | RECEIVED | CANCELLED | LOST
  quantity             NUMERIC(18,3) NOT NULL,
  unit                 TEXT NOT NULL,
  weight_kg            NUMERIC(18,3),
  packed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  packed_by            UUID REFERENCES users(id),
  label_version        INT NOT NULL DEFAULT 1,
  storage_instructions TEXT,
  shelf_life_days      INT,
  expiry_date          DATE,
  cancelled_at         TIMESTAMPTZ,
  cancel_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS packages_order ON packages(order_id);

CREATE TABLE IF NOT EXISTS label_prints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES packages(id),
  version    INT NOT NULL,
  template   TEXT NOT NULL DEFAULT 'A4',
  printed_by UUID REFERENCES users(id),
  reason     TEXT,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS package_scans (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID REFERENCES packages(id),
  code       TEXT NOT NULL,            -- kode yang dipindai (bisa asing)
  action     TEXT NOT NULL,            -- PACK | HANDOVER | PICKUP | DELIVER | RECEIVE | RETURN_PICKUP
  actor_id   UUID REFERENCES users(id),
  actor_role TEXT,
  result     TEXT NOT NULL,            -- OK | REJECTED
  reason     TEXT,
  location   TEXT, lat NUMERIC(10,6), lng NUMERIC(10,6),
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scans_package ON package_scans(package_id);

-- ---------------- PENGIRIMAN: kurir, OTP, bukti penerimaan ----------------
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS courier_user_id UUID REFERENCES users(id);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS otp_hash TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS otp_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivery_evidence JSONB;   -- {method: OTP|PHOTO, recipient_name, evidence_ids[], verified:boolean}
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS manifest_no TEXT;

-- ---------------- PAYMENT TASK (pembayaran ke mitra, maker/checker) ----------------
CREATE TABLE IF NOT EXISTS payment_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_no           TEXT NOT NULL UNIQUE,
  settlement_key    TEXT NOT NULL UNIQUE,   -- scope idempotency: 'ORDER:<order_id>' (satu task per suborder/bagian diterima)
  order_id          UUID NOT NULL REFERENCES orders(id),
  supplier_id       UUID NOT NULL REFERENCES organizations(id),
  status            TEXT NOT NULL DEFAULT 'CREATED', -- ON_HOLD | CREATED | PENDING_APPROVAL | APPROVED | PROCESSING | PAID | FAILED | REJECTED | REVERSED | CANCELLED
  trigger           TEXT NOT NULL,                   -- BUYER_CONFIRM | AUTO_CONFIRM | OPS_CONFIRM | DISPUTE_RESOLVED
  eligible_quantity NUMERIC(18,3) NOT NULL,
  gross_amount      NUMERIC(18,2) NOT NULL,          -- hak mitra bruto (produk diterima sesuai kontrak)
  fee_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,-- komisi/potongan sah (MARKETPLACE: 0 — fee sudah di luar hak; info saja)
  adjustment_amount NUMERIC(18,2) NOT NULL DEFAULT 0,-- refund/penyesuaian tanggung jawab mitra (negatif mengurangi)
  net_amount        NUMERIC(18,2) NOT NULL,          -- = saldo SUPPLIER_PAYABLE order (sumber kebenaran ledger)
  bank_snapshot     JSONB,                           -- rekening terverifikasi saat task dibuat
  due_at            TIMESTAMPTZ,                     -- SLA eksekusi payout (tampil ke mitra)
  hold_reason       TEXT,
  maker_id          UUID REFERENCES users(id), submitted_at TIMESTAMPTZ,
  checker_id        UUID REFERENCES users(id), approved_at TIMESTAMPTZ, rejected_reason TEXT,
  payout_id         UUID REFERENCES payouts(id),
  provider_ref      TEXT,
  processing_at     TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  failure_reason    TEXT,
  reversed_at       TIMESTAMPTZ, reversal_reason TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pt_supplier ON payment_tasks(supplier_id, status);
CREATE INDEX IF NOT EXISTS pt_status ON payment_tasks(status);

CREATE TABLE IF NOT EXISTS payment_task_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES payment_tasks(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor_id    UUID REFERENCES users(id),
  note        TEXT, data JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payouts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS provider_response JSONB;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS inquiry_count INT NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS last_inquiry_at TIMESTAMPTZ;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT TRUE;

-- ---------------- WEBHOOK, JOB, ESKALASI ----------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  event_type      TEXT,
  payload         JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  processed_at    TIMESTAMPTZ,
  result          TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name    TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result      JSONB,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_name ON job_runs(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS escalations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID REFERENCES orders(id),
  task_id     UUID REFERENCES fulfillment_tasks(id),
  kind        TEXT NOT NULL,   -- SUPPLIER_REJECTED | SUPPLIER_LATE | NO_RESPONSE | CONFIRMATION_OVERDUE | EVIDENCE_INVALID | DELIVERY_FAILED | PAYOUT_FAILED | WEIGHT_VARIANCE
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | RESOLVED
  assignee_id UUID REFERENCES users(id),
  resolved_by UUID REFERENCES users(id),
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS escalations_open ON escalations(status) WHERE status='OPEN';

-- ---------------- TIKET CS ----------------
CREATE TABLE IF NOT EXISTS tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no      TEXT NOT NULL UNIQUE,
  order_id       UUID REFERENCES orders(id),
  return_case_id UUID REFERENCES return_cases(id),
  buyer_id       UUID REFERENCES organizations(id),
  supplier_id    UUID REFERENCES organizations(id),
  opened_by      UUID REFERENCES users(id),
  category       TEXT NOT NULL,   -- COMPLAINT | REFUND | DELIVERY | PAYMENT | OTHER
  subject        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | IN_PROGRESS | WAITING_CUSTOMER | ESCALATED | RESOLVED | CLOSED
  priority       INT NOT NULL DEFAULT 3,
  assignee_id    UUID REFERENCES users(id),
  resolution     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id),
  author_id   UUID REFERENCES users(id),
  author_role TEXT,
  body        TEXT NOT NULL,
  internal    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------- NOTIFIKASI ----------------
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  org_id     UUID REFERENCES organizations(id),
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_org ON notifications(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  platform   TEXT NOT NULL,   -- android | web
  token      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------- SETTING DEFAULT v2 (nilai [USULAN]/[ASUMSI], dapat diubah admin) ----------------
INSERT INTO settings(key, value, description) VALUES
 ('confirmation.window_hours', '24', 'Jendela konfirmasi penerimaan pelanggan sejak bukti penerimaan sah (jam)'),
 ('confirmation.auto_confirm_enabled', 'true', 'Auto-confirm setelah jendela berakhir bila bukti penerimaan valid, pembayaran PAID, tanpa sengketa/hold (keputusan Erza 4 Okt 2026)'),
 ('confirmation.require_valid_evidence', 'true', 'Auto-confirm hanya jika delivery_evidence_valid (OTP/foto kurir)'),
 ('payment.expiry_hours', '2', '[ASUMSI] Jendela pembayaran sejak checkout; reservasi stok dilepas saat kedaluwarsa'),
 ('payout.sla_hours', '24', '[USULAN] SLA eksekusi transfer sejak task disetujui checker (tampil ke mitra)'),
 ('payout.provider', '"NONE"', 'NONE = transfer manual/belum terkonfigurasi (task berhenti di APPROVED); MOCK = sandbox; nama provider nyata setelah akun & izin tersedia'),
 ('payout.maker_checker_required', 'true', 'Approval transfer memakai pemisahan maker/checker'),
 ('supplier.response_hours', '12', '[ASUMSI] Batas mitra merespons task penerimaan order; lewat → eskalasi ops'),
 ('delivery.otp_required', 'true', 'Bukti penerimaan sah = OTP penerima; fallback foto kurir perlu verifikasi ops'),
 ('delivery.max_attempts', '2', '[ASUMSI] Maksimum percobaan antar sebelum eskalasi'),
 ('trade.platform_tax_status', '"NON_PKP"', '[ASUMSI] Status PKP Supplier-ID sebagai penjual pada kategori RESELLER — validasi Finance')
ON CONFLICT (key) DO NOTHING;
