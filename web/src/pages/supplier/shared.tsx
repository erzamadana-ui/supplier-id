/** Helper bersama untuk halaman supplier (atribut dinamis kategori, util form). */
import { Field } from '../../components/ui';

export interface AttrField { key: string; label: string; type: 'select' | 'text' | 'number' | 'date'; required?: boolean; options?: string[]; unit?: string }

/** Render input dinamis sesuai attribute_schema kategori. */
export function AttributeInputs({ schema, value, onChange, disabled }: { schema: AttrField[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void; disabled?: boolean }) {
  if (!schema?.length) return null;
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  return (
    <>
      {schema.map((f) => {
        const v = value?.[f.key] ?? '';
        const label = f.unit ? `${f.label} (${f.unit})` : f.label;
        return (
          <Field key={f.key} label={label} required={!!f.required}>
            {f.type === 'select' ? (
              <select value={v} disabled={disabled} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">— pilih —</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === 'number' ? (
              <input type="number" step="any" value={v} disabled={disabled} placeholder={f.unit ?? ''} onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))} />
            ) : f.type === 'date' ? (
              <input type="date" value={v} disabled={disabled} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <input type="text" value={v} disabled={disabled} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </Field>
        );
      })}
    </>
  );
}

/** Tampilkan nilai atribut dinamis dengan label dari schema. */
export function attributeLabel(schema: AttrField[] | undefined, key: string) {
  const f = (schema ?? []).find((x) => x.key === key);
  return f ? (f.unit ? `${f.label} (${f.unit})` : f.label) : key;
}

/** Hapus string kosong/undefined dari payload sebelum dikirim (zod optional tidak menerima ''). */
export function compact<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = compact(v);
      if (Object.keys(inner).length) out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Nilai default input datetime-local = sekarang (zona waktu lokal). */
export function nowLocal() {
  const n = new Date();
  n.setSeconds(0, 0);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
}

/** Tanggal (YYYY-MM-DD) dari string ISO/Date untuk input type=date. */
export function toDateInput(s: any) {
  if (!s) return '';
  const dd = new Date(s);
  if (isNaN(dd.getTime())) return String(s).slice(0, 10);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`;
}

export const BATCH_TYPE_LABEL: Record<string, string> = { READY_STOCK: 'Ready stock', HARVEST: 'Panen (pre-order)' };
export const HARVEST_STAGE_LABEL: Record<string, string> = { UPCOMING: 'Akan panen', PRE_HARVEST_UPDATED: 'Pre-harvest update', FINAL: 'Final' };
export const PHOTO_KIND_LABEL: Record<string, string> = {
  OVERALL: 'Keseluruhan barang', CLOSEUP: 'Close-up kualitas', PACKAGING: 'Kondisi packaging/penyimpanan', CURRENT: 'Kondisi saat ini',
  PRE_HARVEST: 'Pre-harvest (menjelang panen)', FINAL: 'Hasil panen final', OTHER: 'Lainnya',
};
export const OWNER_TYPE_LABEL: Record<string, string> = {
  BATCH: 'Foto deklarasi batch', HARVEST_CURRENT: 'Kondisi saat ini (pra-publikasi)', HARVEST_PRE: 'Pre-harvest update', HARVEST_FINAL: 'Deklarasi final panen',
};
export const FIELD_LABEL: Record<string, string> = {
  grade: 'Grade', quantity: 'Kuantitas', unit: 'Satuan', expected_weight_kg: 'Perkiraan berat (kg)', weight_tolerance_pct: 'Toleransi berat (%)',
  harvest_date: 'Tanggal panen', availability_date: 'Tanggal tersedia', 'harvest_date|availability_date': 'Tanggal panen atau tanggal tersedia',
  condition: 'Kondisi', size: 'Ukuran', color: 'Warna', freshness: 'Kesegaran', moisture: 'Kelembapan/kadar air', temperature_c: 'Suhu penyimpanan (°C)',
  shelf_life_days: 'Umur simpan (hari)', expiry_date: 'Tanggal kedaluwarsa', price_per_unit: 'Harga per satuan',
};
