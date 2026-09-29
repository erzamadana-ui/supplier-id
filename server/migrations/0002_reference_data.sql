-- Data referensi: kategori (skema atribut dinamis), reason code, deklarasi, setting, fee, aturan pajak.

INSERT INTO categories (code, name, tax_class, attribute_schema) VALUES
('TELUR', 'Telur', 'BASIC_NEEDS_EXEMPT', '[
  {"key":"size","label":"Ukuran (gram/butir)","type":"select","required":true,"options":["S (<50g)","M (50-60g)","L (60-70g)","XL (>70g)"]},
  {"key":"shell_condition","label":"Kondisi cangkang","type":"select","required":true,"options":["Utuh & bersih","Utuh kotor ringan","Retak halus sebagian"]},
  {"key":"grade","label":"Grade","type":"select","required":true,"options":["A","B","C"]},
  {"key":"production_date","label":"Tanggal produksi","type":"date","required":true},
  {"key":"storage","label":"Penyimpanan","type":"select","required":false,"options":["Suhu ruang","Chiller"]}
]'),
('SAYUR', 'Sayur', 'BASIC_NEEDS_EXEMPT', '[
  {"key":"freshness","label":"Kesegaran","type":"select","required":true,"options":["Baru panen (<24 jam)","1-2 hari","3+ hari"]},
  {"key":"size","label":"Ukuran","type":"select","required":true,"options":["Kecil","Sedang","Besar","Campur"]},
  {"key":"color","label":"Warna","type":"text","required":true},
  {"key":"harvest_date","label":"Tanggal panen","type":"date","required":true},
  {"key":"defect_tolerance_pct","label":"Toleransi cacat (%)","type":"number","required":true,"unit":"%"},
  {"key":"moisture","label":"Kelembapan/kondisi","type":"select","required":false,"options":["Kering","Lembap","Basah"]}
]'),
('DAGING', 'Daging', 'STANDARD', '[
  {"key":"cut","label":"Potongan (cut)","type":"text","required":true},
  {"key":"weight_per_pack_kg","label":"Berat per kemasan (kg)","type":"number","required":true,"unit":"kg"},
  {"key":"storage_temperature_c","label":"Suhu penyimpanan (°C)","type":"number","required":true,"unit":"°C"},
  {"key":"slaughter_date","label":"Tanggal produksi/pemotongan","type":"date","required":true},
  {"key":"state","label":"Frozen/Chilled","type":"select","required":true,"options":["Frozen","Chilled"]},
  {"key":"halal_cert","label":"Sertifikat halal","type":"text","required":false}
]'),
('IKAN', 'Ikan & Hasil Laut', 'BASIC_NEEDS_EXEMPT', '[
  {"key":"species","label":"Spesies","type":"text","required":true},
  {"key":"weight_per_fish_kg","label":"Berat per ekor (kg)","type":"number","required":true,"unit":"kg"},
  {"key":"state","label":"Fresh/Frozen","type":"select","required":true,"options":["Fresh","Frozen"]},
  {"key":"catch_date","label":"Tanggal tangkap/produksi","type":"date","required":true},
  {"key":"temperature_c","label":"Suhu (°C)","type":"number","required":true,"unit":"°C"}
]'),
('BUAH', 'Buah', 'BASIC_NEEDS_EXEMPT', '[
  {"key":"ripeness","label":"Kematangan","type":"select","required":true,"options":["Mengkal","Matang","Sangat matang"]},
  {"key":"size","label":"Ukuran","type":"select","required":true,"options":["Kecil","Sedang","Besar","Campur"]},
  {"key":"harvest_date","label":"Tanggal panen","type":"date","required":true},
  {"key":"brix","label":"Kadar gula (Brix)","type":"number","required":false}
]'),
('BERAS', 'Beras & Biji-bijian', 'BASIC_NEEDS_EXEMPT', '[
  {"key":"variety","label":"Varietas","type":"text","required":true},
  {"key":"moisture_pct","label":"Kadar air (%)","type":"number","required":true,"unit":"%"},
  {"key":"broken_pct","label":"Butir patah (%)","type":"number","required":true,"unit":"%"},
  {"key":"milling_date","label":"Tanggal giling","type":"date","required":true}
]');

INSERT INTO return_reason_codes (code, label, requires_video, sort_order) VALUES
('DAMAGED','Rusak',TRUE,10),
('ROTTEN','Busuk',TRUE,20),
('NOT_FRESH','Tidak segar',TRUE,30),
('WRONG_GRADE','Grade tidak sesuai',TRUE,40),
('WRONG_SIZE','Ukuran tidak sesuai',TRUE,50),
('WRONG_PRODUCT','Produk salah',TRUE,60),
('WEIGHT_MISMATCH','Berat tidak sesuai',TRUE,70),
('QUANTITY_MISMATCH','Jumlah tidak sesuai',TRUE,80),
('TEMPERATURE_ISSUE','Masalah suhu',TRUE,90),
('PACKAGING_DAMAGE','Kemasan rusak',TRUE,100),
('QUALITY_NOT_AS_DECLARED','Kualitas tidak sesuai deklarasi',TRUE,110),
('OTHER','Lainnya',TRUE,120);

INSERT INTO declaration_versions (version, title, body) VALUES
(1, 'Quality Self Declaration & Return Guarantee v1',
'Saya selaku supplier menyatakan bahwa: (1) seluruh informasi produk benar; (2) foto menggambarkan kondisi barang yang ditawarkan dan berasal dari batch yang dijual; (3) kualitas sesuai deskripsi; (4) jumlah/berat sesuai toleransi yang ditentukan; (5) saya bertanggung jawab atas ketidaksesuaian kualitas yang terbukti; (6) saya bersedia menerima retur/refund sesuai kebijakan Supplier.id apabila barang yang diterima tidak sesuai deklarasi atau rusak sebelum diterima buyer.');

-- PLATFORM FEE default 15% — parameter sistem, BUKAN hard-code
INSERT INTO fee_configs (fee_key, scope_type, rate_percent, effective_from, reason, status)
VALUES ('PLATFORM_FEE', 'GLOBAL', 15.0000, '2026-01-01T00:00:00Z', 'Default platform fee (MVP)', 'ACTIVE');

INSERT INTO settings (key, value, description) VALUES
('evidence.min_photos', '3', 'Minimum foto deklarasi kualitas per batch (default global)'),
('evidence.required_kinds', '["OVERALL","CLOSEUP","PACKAGING"]', 'Jenis foto wajib deklarasi'),
('evidence.location_optional', 'true', 'Metadata lokasi bersifat opsional dengan persetujuan pengguna'),
('harvest.pre_harvest_reminder_days', '7', 'Sistem meminta pre-harvest update H-n sebelum panen'),
('fee.change_requires_approval', 'false', 'Jika true, perubahan fee butuh approved_by sebelum ACTIVE'),
('packaging.rate_per_kg', '250', 'Tarif packaging yang ditagihkan ke buyer per kg (default global)'),
('packaging.cost_ratio', '0.8', 'Estimasi biaya packaging sebagai rasio dari packaging revenue (margin = 1 - rasio)'),
('logistics.base_fee', '150000', 'Biaya dasar pengiriman'),
('logistics.rate_per_km', '3500', 'Tarif per km'),
('logistics.rate_per_kg', '350', 'Tarif per kg'),
('logistics.cost_ratio', '0.85', 'Biaya ke penyedia logistik sebagai rasio dari logistics revenue'),
('logistics.return_cost_ratio', '0.5', 'Biaya return pickup sebagai rasio dari biaya logistik awal'),
('payment.fee_percent', '1.0', 'Payment fee yang ditagihkan ke buyer (%)'),
('payment.fee_fixed', '0', 'Payment fee tetap (Rp) per transaksi'),
('payment.provider_fee_percent', '1.0', 'Biaya yang dipotong provider dari platform (%)'),
('payment.provider_fee_fixed', '0', 'Biaya tetap provider (Rp)'),
('payment.fee_refundable', 'false', 'Apakah payment fee dikembalikan saat refund (aturan provider)'),
('return.claim_window_hours', '24', 'Batas waktu klaim sejak barang tiba'),
('return.require_video', 'true', 'Klaim wajib video selain foto'),
('return.policy', '{
  "PRODUCT":        {"SUPPLIER":"PRORATA","PACKAGING":"PRORATA","LOGISTICS":"PRORATA","BUYER_RECEIVING":"NONE","OTHER":"PRORATA","UNDETERMINED":"PRORATA"},
  "PLATFORM_FEE":   {"SUPPLIER":"PRORATA","PACKAGING":"PRORATA","LOGISTICS":"PRORATA","BUYER_RECEIVING":"NONE","OTHER":"PRORATA","UNDETERMINED":"PRORATA"},
  "PACKAGING":      {"SUPPLIER":"PRORATA","PACKAGING":"PRORATA","LOGISTICS":"NONE","BUYER_RECEIVING":"NONE","OTHER":"NONE","UNDETERMINED":"NONE"},
  "LOGISTICS":      {"SUPPLIER":"NONE","PACKAGING":"NONE","LOGISTICS":"PRORATA","BUYER_RECEIVING":"NONE","OTHER":"NONE","UNDETERMINED":"NONE"},
  "OPTIONAL_SERVICE":{"SUPPLIER":"NONE","PACKAGING":"NONE","LOGISTICS":"NONE","BUYER_RECEIVING":"NONE","OTHER":"NONE","UNDETERMINED":"NONE"},
  "PAYMENT_FEE":    {"SUPPLIER":"NONE","PACKAGING":"NONE","LOGISTICS":"NONE","BUYER_RECEIVING":"NONE","OTHER":"NONE","UNDETERMINED":"NONE"},
  "product_loss_bearer": {"SUPPLIER":"SUPPLIER","PACKAGING":"SUPPLIER","LOGISTICS":"LOGISTICS","BUYER_RECEIVING":"BUYER","OTHER":"PLATFORM","UNDETERMINED":"PLATFORM"},
  "return_logistics_bearer": {"SUPPLIER":"SUPPLIER","PACKAGING":"SUPPLIER","LOGISTICS":"LOGISTICS","BUYER_RECEIVING":"BUYER","OTHER":"PLATFORM","UNDETERMINED":"PLATFORM"}
}', 'Kebijakan refund per komponen & penanggung biaya menurut atribusi penyebab (configurable)'),
('quality.weights', '{"acceptance_rate":25,"return_rate":20,"damage_rate":10,"quality_mismatch":10,"weight_mismatch":10,"late_fulfillment":10,"cancellation":5,"dispute_history":5,"declaration_accuracy":5}', 'Bobot Quality Score (total 100)'),
('quality.enforcement', '{"warning":{"return_rate_gt":10},"rank_down":{"return_rate_gt":15},"verification_required":{"return_rate_gt":20},"listing_limited":{"return_rate_gt":30},"under_review":{"return_rate_gt":40},"min_orders":3}', 'Ambang enforcement supplier (configurable)'),
('optional_services', '[{"code":"INSURANCE","label":"Asuransi pengiriman","mode":"PERCENT_OF_PRODUCT","value":0.5},{"code":"COLD_CHAIN","label":"Cold chain","mode":"PER_KG","value":500},{"code":"HANDLING","label":"Additional handling","mode":"FIXED","value":100000}]', 'Layanan opsional yang bisa dipilih buyer'),
('promotions', '[{"code":"HEMAT5","label":"Diskon 5% (maks Rp500.000)","mode":"PERCENT_OF_PRODUCT","value":5,"max":500000,"active":true}]', 'Kode promo aktif');

-- ATURAN PAJAK (configurable oleh Finance). Nilai default ditandai sebagai ASUMSI — wajib divalidasi Finance/konsultan pajak.
-- Prinsip: komponen PRODUCT dipungut PPN hanya bila supplier PKP dan kategori bukan barang kebutuhan pokok (tax_class STANDARD).
-- Komponen jasa platform (PLATFORM_FEE, PACKAGING, LOGISTICS, OPTIONAL_SERVICE) dipungut PPN karena Supplier.id diasumsikan PKP.
-- PAYMENT_FEE diperlakukan pass-through (tidak dipungut PPN oleh platform).
INSERT INTO tax_rules (name, component, seller_status, service_type, taxable, rate_percent, dpp_factor, priority) VALUES
('PPN produk – supplier PKP, kategori standar',        'PRODUCT',          'PKP',     'STANDARD',            TRUE,  11.0000, 1, 10),
('PPN produk dibebaskan – barang kebutuhan pokok',     'PRODUCT',          'ANY',     'BASIC_NEEDS_EXEMPT',  FALSE, 0,       1, 5),
('Produk supplier non-PKP – tidak memungut PPN',        'PRODUCT',          'NON_PKP', 'ANY',                 FALSE, 0,       1, 20),
('PPN jasa platform fee',                               'PLATFORM_FEE',     'ANY',     'ANY',                 TRUE,  11.0000, 1, 50),
('PPN jasa packaging',                                  'PACKAGING',        'ANY',     'ANY',                 TRUE,  11.0000, 1, 50),
('PPN jasa logistik',                                   'LOGISTICS',        'ANY',     'ANY',                 TRUE,  11.0000, 1, 50),
('PPN layanan opsional',                                'OPTIONAL_SERVICE', 'ANY',     'ANY',                 TRUE,  11.0000, 1, 50),
('Payment fee pass-through – tidak dipungut',           'PAYMENT_FEE',      'ANY',     'ANY',                 FALSE, 0,       1, 50);
