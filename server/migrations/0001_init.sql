-- Supplier.id — skema inti (v1)
-- Prinsip: DECLARE → PROVE → DELIVER → INSPECT → EVIDENCE → SETTLE
-- Semua nilai uang dalam Rupiah, NUMERIC(18,2). Persentase NUMERIC(7,4) (15.0000 = 15%).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- IDENTITAS
-- ---------------------------------------------------------------
CREATE TYPE org_type AS ENUM ('SUPPLIER','BUYER','PLATFORM','LOGISTICS');
CREATE TYPE supplier_kind AS ENUM ('PETANI','PETERNAK','NELAYAN','SUPPLIER','KELOMPOK_TANI','KOPERASI','PRODUSEN');
CREATE TYPE tax_status AS ENUM ('PKP','NON_PKP');
CREATE TYPE user_role AS ENUM ('ADMIN','SUPPLIER','BUYER');
CREATE TYPE org_status AS ENUM ('ACTIVE','WARNING','VERIFICATION_REQUIRED','LISTING_LIMITED','UNDER_REVIEW','SUSPENDED');

CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          org_type NOT NULL,
  name          TEXT NOT NULL,
  supplier_kind supplier_kind,
  tax_status    tax_status NOT NULL DEFAULT 'NON_PKP',
  region        TEXT,
  address       TEXT,
  status        org_status NOT NULL DEFAULT 'ACTIVE',
  status_reason TEXT,
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  bank_account  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          user_role NOT NULL,
  org_id        UUID REFERENCES organizations(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- KATALOG DINAMIS
-- ---------------------------------------------------------------
CREATE TABLE categories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  -- skema atribut kualitas dinamis: [{key,label,type,required,options?,unit?}]
  attribute_schema JSONB NOT NULL DEFAULT '[]',
  tax_class        TEXT NOT NULL DEFAULT 'STANDARD',   -- STANDARD | BASIC_NEEDS_EXEMPT
  min_photos       INT,                                -- NULL = pakai default global
  packaging_rate_per_unit NUMERIC(18,2),              -- NULL = pakai default global
  active           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TYPE product_status AS ENUM ('DRAFT','PENDING_DECLARATION','ACTIVE','UPCOMING_HARVEST','INACTIVE','SUSPENDED');

CREATE TABLE products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id       UUID NOT NULL REFERENCES organizations(id),
  category_id       UUID NOT NULL REFERENCES categories(id),
  name              TEXT NOT NULL,
  commodity         TEXT NOT NULL,
  variety           TEXT,
  unit              TEXT NOT NULL DEFAULT 'KG',
  origin            TEXT,
  production_method TEXT,
  certification     TEXT,
  status            product_status NOT NULL DEFAULT 'DRAFT',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE batch_type   AS ENUM ('READY_STOCK','HARVEST');
CREATE TYPE batch_status AS ENUM ('DRAFT','UPCOMING','PRE_HARVEST_UPDATED','READY_FOR_ORDER','SOLD_OUT','CLOSED');

CREATE TABLE batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID NOT NULL REFERENCES products(id),
  supplier_id        UUID NOT NULL REFERENCES organizations(id),
  type               batch_type NOT NULL,
  status             batch_status NOT NULL DEFAULT 'DRAFT',
  batch_code         TEXT NOT NULL UNIQUE,
  grade              TEXT,
  quantity           NUMERIC(18,3) NOT NULL DEFAULT 0,   -- kuantitas dideklarasikan
  available_quantity NUMERIC(18,3) NOT NULL DEFAULT 0,
  unit               TEXT NOT NULL DEFAULT 'KG',
  expected_weight_kg NUMERIC(18,3),
  weight_tolerance_pct NUMERIC(7,4) NOT NULL DEFAULT 2.0,
  harvest_date       DATE,
  availability_date  DATE,
  condition          TEXT,
  size               TEXT,
  color              TEXT,
  freshness          TEXT,
  moisture           TEXT,
  temperature_c      NUMERIC(6,2),
  shelf_life_days    INT,
  expiry_date        DATE,
  attributes         JSONB NOT NULL DEFAULT '{}',        -- atribut dinamis per kategori
  price_per_unit     NUMERIC(18,2) NOT NULL DEFAULT 0,
  declaration_accepted_at TIMESTAMPTZ,
  published_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE harvest_stage AS ENUM ('UPCOMING','PRE_HARVEST_UPDATED','FINAL');

CREATE TABLE harvests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              UUID NOT NULL UNIQUE REFERENCES batches(id),
  stage                 harvest_stage NOT NULL DEFAULT 'UPCOMING',
  planting_date         DATE,
  expected_harvest_date DATE NOT NULL,
  expected_quantity     NUMERIC(18,3) NOT NULL,
  expected_grade        TEXT,
  expected_quality      TEXT,
  current_condition     TEXT,
  forecast_confidence   INT CHECK (forecast_confidence BETWEEN 0 AND 100),
  pre_harvest_note      TEXT,
  pre_harvest_updated_at TIMESTAMPTZ,
  actual_quantity       NUMERIC(18,3),
  actual_grade          TEXT,
  actual_weight_kg      NUMERIC(18,3),
  actual_condition      TEXT,
  actual_harvest_date   DATE,
  finalized_at          TIMESTAMPTZ
);

-- ---------------------------------------------------------------
-- BUKTI FOTO / VIDEO
-- ---------------------------------------------------------------
CREATE TYPE evidence_owner AS ENUM ('BATCH','HARVEST_CURRENT','HARVEST_PRE','HARVEST_FINAL','INSPECTION','RETURN','SHIPMENT');
CREATE TYPE evidence_kind  AS ENUM ('OVERALL','CLOSEUP','PACKAGING','CURRENT','PRE_HARVEST','FINAL','RECEIVING_PHOTO','RECEIVING_VIDEO','RETURN_PHOTO','RETURN_VIDEO','PICKUP','OTHER');

CREATE TABLE evidence_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    evidence_owner NOT NULL,
  kind          evidence_kind NOT NULL,
  media_type    TEXT NOT NULL,                 -- image/jpeg, video/mp4 ...
  file_path     TEXT NOT NULL,
  sha256        TEXT,
  supplier_id   UUID REFERENCES organizations(id),
  buyer_id      UUID REFERENCES organizations(id),
  product_id    UUID REFERENCES products(id),
  batch_id      UUID REFERENCES batches(id),
  harvest_id    UUID REFERENCES harvests(id),
  order_id      UUID,
  shipment_id   UUID,
  inspection_id UUID,
  return_case_id UUID,
  taken_at      TIMESTAMPTZ,                   -- timestamp dari perangkat/klien
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by   UUID REFERENCES users(id),
  lat           NUMERIC(9,6),
  lng           NUMERIC(9,6),
  location_consent BOOLEAN NOT NULL DEFAULT FALSE,
  is_stock_image BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT no_stock_image CHECK (is_stock_image = FALSE)
);
CREATE INDEX ON evidence_files(batch_id);
CREATE INDEX ON evidence_files(order_id);

-- ---------------------------------------------------------------
-- DEKLARASI KUALITAS & JAMINAN RETUR
-- ---------------------------------------------------------------
CREATE TABLE declaration_versions (
  version    INT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE declaration_acceptances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id         UUID NOT NULL REFERENCES organizations(id),
  user_id             UUID NOT NULL REFERENCES users(id),
  declaration_version INT NOT NULL REFERENCES declaration_versions(version),
  product_id          UUID NOT NULL REFERENCES products(id),
  batch_id            UUID NOT NULL REFERENCES batches(id),
  accepted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address          TEXT,
  user_agent          TEXT,
  declared_snapshot   JSONB NOT NULL   -- salinan data batch saat deklarasi
);

-- ---------------------------------------------------------------
-- RFQ / QUOTATION / NEGOSIASI
-- ---------------------------------------------------------------
CREATE TYPE rfq_status   AS ENUM ('OPEN','QUOTED','ACCEPTED','CLOSED','CANCELLED');
CREATE TYPE quote_status AS ENUM ('PENDING','COUNTERED','ACCEPTED','REJECTED','EXPIRED');
CREATE TYPE party_type   AS ENUM ('BUYER','SUPPLIER','PLATFORM');

CREATE TABLE rfqs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_no           TEXT NOT NULL UNIQUE,
  buyer_id         UUID NOT NULL REFERENCES organizations(id),
  category_id      UUID REFERENCES categories(id),
  batch_id         UUID REFERENCES batches(id),          -- opsional: RFQ untuk listing tertentu
  commodity        TEXT NOT NULL,
  quantity         NUMERIC(18,3) NOT NULL,
  unit             TEXT NOT NULL DEFAULT 'KG',
  target_price     NUMERIC(18,2),
  required_grade   TEXT,
  delivery_address TEXT,
  delivery_region  TEXT,
  distance_km      NUMERIC(10,2) NOT NULL DEFAULT 0,
  needed_by        DATE,
  status           rfq_status NOT NULL DEFAULT 'OPEN',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id         UUID NOT NULL REFERENCES rfqs(id),
  supplier_id    UUID NOT NULL REFERENCES organizations(id),
  batch_id       UUID NOT NULL REFERENCES batches(id),
  parent_id      UUID REFERENCES quotations(id),
  proposed_by    party_type NOT NULL,
  round          INT NOT NULL DEFAULT 1,
  price_per_unit NUMERIC(18,2) NOT NULL,
  quantity       NUMERIC(18,3) NOT NULL,
  message        TEXT,
  valid_until    TIMESTAMPTZ,
  status         quote_status NOT NULL DEFAULT 'PENDING',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- KONFIGURASI FEE, PAJAK, SETTING
-- ---------------------------------------------------------------
CREATE TYPE fee_scope   AS ENUM ('GLOBAL','CATEGORY','SUPPLIER','BUYER','CONTRACT','PROMOTION','VALUE_TIER','REGION');
CREATE TYPE fee_status  AS ENUM ('PENDING_APPROVAL','ACTIVE','REJECTED','SUPERSEDED');

CREATE TABLE fee_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_key         TEXT NOT NULL DEFAULT 'PLATFORM_FEE',
  scope_type      fee_scope NOT NULL DEFAULT 'GLOBAL',
  scope_ref       TEXT,                          -- id kategori/supplier/buyer/kontrak/promo/region; VALUE_TIER: "min-max"
  rate_percent    NUMERIC(7,4) NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to    TIMESTAMPTZ,
  previous_value  NUMERIC(7,4),
  reason          TEXT,
  status          fee_status NOT NULL DEFAULT 'ACTIVE',
  created_by      UUID REFERENCES users(id),
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON fee_configs(fee_key, scope_type, scope_ref, effective_from);

CREATE TYPE price_component AS ENUM ('PRODUCT','PLATFORM_FEE','PACKAGING','LOGISTICS','PAYMENT_FEE','OPTIONAL_SERVICE');

CREATE TABLE tax_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  component        price_component NOT NULL,
  transaction_type TEXT NOT NULL DEFAULT 'ANY',       -- ANY | MARKETPLACE | CONTRACT
  seller_status    TEXT NOT NULL DEFAULT 'ANY',       -- ANY | PKP | NON_PKP  (penjual komponen tsb: supplier utk PRODUCT, platform utk lainnya)
  buyer_status     TEXT NOT NULL DEFAULT 'ANY',
  service_type     TEXT NOT NULL DEFAULT 'ANY',       -- ANY | tax_class kategori | jenis layanan
  taxable          BOOLEAN NOT NULL DEFAULT TRUE,
  rate_percent     NUMERIC(7,4) NOT NULL DEFAULT 0,
  dpp_factor       NUMERIC(9,6) NOT NULL DEFAULT 1,   -- faktor dasar pengenaan pajak (mis. 11/12 = 0.916667) — dikonfigurasi Finance
  priority         INT NOT NULL DEFAULT 100,          -- lebih kecil = lebih spesifik/menang
  effective_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to     TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE config_audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     TEXT NOT NULL,        -- fee_configs | tax_rules | settings | return_reason_codes | organizations
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,        -- CREATE | UPDATE | APPROVE | REJECT | DELETE
  before     JSONB,
  after      JSONB,
  reason     TEXT,
  user_id    UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE return_reason_codes (
  code       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  requires_video BOOLEAN NOT NULL DEFAULT TRUE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 100
);

-- ---------------------------------------------------------------
-- ORDER, PEMBAYARAN, PENGIRIMAN
-- ---------------------------------------------------------------
CREATE TYPE order_status AS ENUM (
  'DRAFT','PENDING_PAYMENT','PAID','PACKING','PICKED_UP','IN_TRANSIT',
  'ARRIVED_WAITING_INSPECTION','ACCEPTED','PARTIALLY_ACCEPTED','REJECTED',
  'DISPUTED','SETTLED','CANCELLED'
);

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no            TEXT NOT NULL UNIQUE,
  buyer_id            UUID NOT NULL REFERENCES organizations(id),
  supplier_id         UUID NOT NULL REFERENCES organizations(id),
  product_id          UUID NOT NULL REFERENCES products(id),
  batch_id            UUID NOT NULL REFERENCES batches(id),
  rfq_id              UUID REFERENCES rfqs(id),
  quotation_id        UUID REFERENCES quotations(id),
  status              order_status NOT NULL DEFAULT 'DRAFT',
  quantity            NUMERIC(18,3) NOT NULL,
  unit                TEXT NOT NULL,
  unit_price          NUMERIC(18,2) NOT NULL,
  weight_kg           NUMERIC(18,3) NOT NULL DEFAULT 0,
  distance_km         NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_address    TEXT,
  optional_services   JSONB NOT NULL DEFAULT '[]',   -- [{code,label,amount}]
  promo_code          TEXT,
  -- PRICING SNAPSHOT (terkunci saat konfirmasi; tidak berubah walau konfigurasi berubah)
  pricing_locked_at   TIMESTAMPTZ,
  fee_config_id       UUID REFERENCES fee_configs(id),
  platform_fee_rate   NUMERIC(7,4),
  product_value       NUMERIC(18,2) NOT NULL DEFAULT 0,
  platform_fee_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  packaging_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  logistics_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  payment_fee_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
  optional_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  pricing_snapshot    JSONB,                          -- rincian penuh termasuk tax lines & cost basis
  -- hasil inspeksi
  accepted_quantity   NUMERIC(18,3),
  rejected_quantity   NUMERIC(18,3),
  -- jejak waktu
  confirmed_at        TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  packed_at           TIMESTAMPTZ,
  picked_up_at        TIMESTAMPTZ,
  arrived_at          TIMESTAMPTZ,
  inspected_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  promised_pickup_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON orders(buyer_id); CREATE INDEX ON orders(supplier_id); CREATE INDEX ON orders(status);

CREATE TABLE order_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id),
  from_status order_status,
  to_status  order_status NOT NULL,
  actor_id   UUID REFERENCES users(id),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE payment_status AS ENUM ('PENDING','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED');

CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id),
  provider      TEXT NOT NULL DEFAULT 'MOCK_GATEWAY',
  channel       TEXT NOT NULL DEFAULT 'VA',
  amount        NUMERIC(18,2) NOT NULL,
  provider_fee  NUMERIC(18,2) NOT NULL DEFAULT 0,   -- biaya yang dipotong provider dari platform
  status        payment_status NOT NULL DEFAULT 'PENDING',
  provider_ref  TEXT,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE shipment_type   AS ENUM ('DELIVERY','RETURN');
CREATE TYPE shipment_status AS ENUM ('SCHEDULED','PICKED_UP','IN_TRANSIT','ARRIVED','DELIVERED','RECEIVED');

CREATE TABLE shipments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders(id),
  return_case_id UUID,
  type           shipment_type NOT NULL DEFAULT 'DELIVERY',
  status         shipment_status NOT NULL DEFAULT 'SCHEDULED',
  carrier        TEXT,
  driver_name    TEXT,
  vehicle        TEXT,
  packaging_type TEXT,
  cold_chain     BOOLEAN NOT NULL DEFAULT FALSE,
  tracking_no    TEXT,
  route          JSONB NOT NULL DEFAULT '[]',
  pickup_at      TIMESTAMPTZ,
  arrived_at     TIMESTAMPTZ,
  logistics_cost NUMERIC(18,2) NOT NULL DEFAULT 0,  -- biaya yang harus dibayar ke penyedia logistik
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipment_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES shipments(id),
  event_type  TEXT NOT NULL,      -- PICKUP | CHECKPOINT | TEMPERATURE | DELAY | ARRIVED | DELIVERED | RECEIVED
  location    TEXT,
  lat         NUMERIC(9,6),
  lng         NUMERIC(9,6),
  temperature_c NUMERIC(6,2),
  note        TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- INSPEKSI PENERIMAAN, RETUR, DISPUTE
-- ---------------------------------------------------------------
CREATE TYPE inspection_decision AS ENUM ('ACCEPT','PARTIAL_ACCEPT','REJECT');

CREATE TABLE inspections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL UNIQUE REFERENCES orders(id),
  shipment_id       UUID NOT NULL REFERENCES shipments(id),
  buyer_id          UUID NOT NULL REFERENCES organizations(id),
  inspector_id      UUID REFERENCES users(id),
  decision          inspection_decision NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_quantity NUMERIC(18,3) NOT NULL,
  rejected_quantity NUMERIC(18,3) NOT NULL DEFAULT 0,
  measured_weight_kg NUMERIC(18,3),
  measured_temperature_c NUMERIC(6,2),
  notes             TEXT
);

CREATE TYPE return_status AS ENUM (
  'REQUESTED','EVIDENCE_REVIEW','APPROVED','PARTIALLY_APPROVED','REJECTED',
  'PICKUP_SCHEDULED','IN_TRANSIT','RECEIVED_BY_SUPPLIER','CLOSED'
);
CREATE TYPE fault_attribution AS ENUM ('SUPPLIER','PACKAGING','LOGISTICS','BUYER_RECEIVING','OTHER','UNDETERMINED');

CREATE TABLE return_cases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no             TEXT NOT NULL UNIQUE,
  order_id            UUID NOT NULL REFERENCES orders(id),
  inspection_id       UUID NOT NULL REFERENCES inspections(id),
  shipment_id         UUID NOT NULL REFERENCES shipments(id),
  batch_id            UUID NOT NULL REFERENCES batches(id),
  buyer_id            UUID NOT NULL REFERENCES organizations(id),
  supplier_id         UUID NOT NULL REFERENCES organizations(id),
  status              return_status NOT NULL DEFAULT 'REQUESTED',
  reason_code         TEXT NOT NULL REFERENCES return_reason_codes(code),
  description         TEXT,
  quantity_affected   NUMERIC(18,3) NOT NULL,
  approved_quantity   NUMERIC(18,3),
  eligibility         JSONB,          -- hasil automated eligibility check
  fault_attribution   fault_attribution,
  decision_notes      TEXT,
  decided_by          UUID REFERENCES users(id),
  decided_at          TIMESTAMPTZ,
  return_logistics_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  cost_allocation     JSONB,          -- {SUPPLIER:x, BUYER:y, PLATFORM:z, LOGISTICS:w}
  received_at         TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE dispute_status AS ENUM ('OPEN','UNDER_REVIEW','RESOLVED');

CREATE TABLE disputes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_case_id UUID NOT NULL UNIQUE REFERENCES return_cases(id),
  order_id       UUID NOT NULL REFERENCES orders(id),
  opened_by      party_type NOT NULL,
  status         dispute_status NOT NULL DEFAULT 'OPEN',
  supplier_statement TEXT,
  buyer_statement    TEXT,
  resolution     JSONB,
  resolved_by    UUID REFERENCES users(id),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE financial_adjustments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id),
  return_case_id   UUID REFERENCES return_cases(id),
  adjustment_type  TEXT NOT NULL,           -- RETURN_REFUND | CANCELLATION | MANUAL
  fault_attribution fault_attribution,
  components       JSONB NOT NULL,          -- [{component, mode, base, refund, bearer}]
  refund_to_buyer  NUMERIC(18,2) NOT NULL DEFAULT 0,
  supplier_deduction NUMERIC(18,2) NOT NULL DEFAULT 0,
  platform_absorbed NUMERIC(18,2) NOT NULL DEFAULT 0,
  logistics_recovery NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_reversal     NUMERIC(18,2) NOT NULL DEFAULT 0,
  journal_id       UUID,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- LEDGER (double entry) & PAYOUT
-- ---------------------------------------------------------------
CREATE TYPE ledger_account AS ENUM (
  'CASH',                     -- aset: kas/rekening platform (escrow)
  'SUPPLIER_PAYABLE',         -- liabilitas: hak supplier (product value)
  'REFUND_PAYABLE',           -- liabilitas: refund yang harus dikembalikan ke buyer
  'LOGISTICS_PAYABLE',        -- liabilitas: utang ke penyedia logistik
  'TAX_PAYABLE',              -- liabilitas: PPN/pajak yang dipungut
  'PLATFORM_FEE_REVENUE',     -- pendapatan: platform fee 15%
  'PACKAGING_REVENUE',        -- pendapatan: packaging yang ditagihkan
  'LOGISTICS_REVENUE',        -- pendapatan: logistics yang ditagihkan
  'OPTIONAL_SERVICE_REVENUE', -- pendapatan: layanan opsional (asuransi, cold chain, handling)
  'PAYMENT_FEE_COLLECTED',    -- pendapatan pass-through: payment fee dari buyer
  'PACKAGING_COST',           -- beban
  'LOGISTICS_COST',           -- beban
  'PAYMENT_PROCESSING_FEE',   -- beban: dipotong provider
  'PROMOTION_DISCOUNT',       -- kontra pendapatan
  'RETURN_ADJUSTMENT',        -- beban: kerugian retur ditanggung platform
  'LOGISTICS_RECEIVABLE'      -- aset: piutang klaim ke penyedia logistik (recovery)
);
CREATE TYPE ledger_side AS ENUM ('DEBIT','CREDIT');
CREATE TYPE ledger_component AS ENUM (
  'PRODUCT_VALUE','PLATFORM_FEE_REVENUE','PACKAGING_REVENUE','PACKAGING_COST',
  'LOGISTICS_REVENUE','LOGISTICS_PAYABLE','PAYMENT_PROCESSING_FEE','TAX_PAYABLE',
  'REFUND','RETURN_ADJUSTMENT','SUPPLIER_PAYABLE','SUPPLIER_PAYOUT','PROMOTION_DISCOUNT',
  'OPTIONAL_SERVICE','PAYMENT_FEE','CASH_IN','CASH_OUT','LOGISTICS_RECOVERY'
);

CREATE TABLE ledger_journals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_type TEXT NOT NULL,      -- BUYER_PAYMENT | PROVIDER_FEE | PACKAGING_COST | LOGISTICS_COST | RETURN_ADJUSTMENT | REFUND_PAID | SUPPLIER_PAYOUT | LOGISTICS_PAID
  order_id     UUID REFERENCES orders(id),
  return_case_id UUID REFERENCES return_cases(id),
  reference    TEXT,
  memo         TEXT,
  posted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id)
);

CREATE TABLE ledger_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id  UUID NOT NULL REFERENCES ledger_journals(id),
  order_id    UUID REFERENCES orders(id),
  account     ledger_account NOT NULL,
  component   ledger_component NOT NULL,
  side        ledger_side NOT NULL,
  amount      NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  party_type  party_type,
  party_id    UUID,
  memo        TEXT,
  posted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries(order_id); CREATE INDEX ON ledger_entries(account); CREATE INDEX ON ledger_entries(party_id);

CREATE TYPE payout_status AS ENUM ('PENDING','PAID','FAILED');

CREATE TABLE payouts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_no   TEXT NOT NULL UNIQUE,
  supplier_id UUID NOT NULL REFERENCES organizations(id),
  amount      NUMERIC(18,2) NOT NULL,
  order_ids   JSONB NOT NULL DEFAULT '[]',
  status      payout_status NOT NULL DEFAULT 'PENDING',
  journal_id  UUID REFERENCES ledger_journals(id),
  bank_ref    TEXT,
  paid_at     TIMESTAMPTZ,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- QUALITY SCORE
-- ---------------------------------------------------------------
CREATE TABLE supplier_quality_scores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES organizations(id),
  score       NUMERIC(6,2) NOT NULL,
  metrics     JSONB NOT NULL,
  enforcement JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON supplier_quality_scores(supplier_id, computed_at DESC);

CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);
