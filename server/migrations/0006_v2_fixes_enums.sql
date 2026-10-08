-- v2.1 (inspeksi produksi 8 Okt 2026): shipment dapat dibatalkan bersama order agar tidak tersisa di manifest kurir.
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'CANCELLED';

-- [KEPUTUSAN GM DIPERLUKAN] Temuan inspeksi: mitra yang baru mendaftar langsung bisa menayangkan listing dan menerima pembayaran
-- tanpa verifikasi admin. Default tetap false agar perilaku produksi tidak berubah tanpa keputusan; ubah di Admin → Konfigurasi.
INSERT INTO settings(key, value, description) VALUES
 ('supplier.require_verified_to_publish', 'false', '[USULAN: true] Mitra harus diverifikasi admin (Mitra & Quality Score → Verifikasi) sebelum batch bisa dipublikasikan ke katalog')
ON CONFLICT (key) DO NOTHING;
