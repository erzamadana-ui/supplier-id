export interface AuthUser { id: string; email: string; name: string; role: 'ADMIN' | 'SUPPLIER' | 'BUYER'; orgId: string | null }

const TOKEN_KEY = 'supplierid.token';
/** Base URL API (kosong = origin yang sama / proxy Vite). Produksi: VITE_API_URL=https://supplier-api.antarkitaindonesia.com */
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const DEMO_MODE = import.meta.env.VITE_DEMO === 'true';
/** URL berkas bukti: URL absolut (Supabase Storage) atau /uploads/<nama> di API. */
export const fileUrl = (p: string) => (/^https?:\/\//.test(p) ? p : `${API_BASE}/uploads/${p}`);
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
}

async function call<T = any>(method: string, url: string, body?: any): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(url.startsWith('/') ? API_BASE + url : url, { method, headers, body: payload });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error || r.statusText, data?.details);
  return data as T;
}

let _mode: Promise<'direct' | 'multipart'> | null = null;
const uploadMode = () => (_mode ??= call<{ mode: 'direct' | 'multipart' }>('GET', '/api/evidence/mode').then((r) => r.mode).catch(() => 'multipart' as const));

export const api = {
  get: <T = any>(url: string) => call<T>('GET', url),
  post: <T = any>(url: string, body?: any) => call<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: any) => call<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: any) => call<T>('PATCH', url, body ?? {}),
  /**
   * Unggah bukti foto/video. meta: owner_type, kind, batch_id/order_id, taken_at, lat, lng, location_consent.
   * Mode 'direct' (produksi): minta signed URL → unggah langsung ke Supabase Storage → catat metadata. Mode 'multipart' (lokal): lewat API.
   */
  upload: async (file: File, meta: Record<string, any>) => {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null && v !== '') clean[k] = v;
    if ((await uploadMode()) === 'direct') {
      const mediaType = file.type || (/\.(mp4|mov|webm)$/i.test(file.name) ? 'video/mp4' : 'image/jpeg');
      const signed = await call<{ key: string; upload_url: string }>('POST', '/api/evidence/sign', { filename: file.name, media_type: mediaType });
      const put = await fetch(signed.upload_url, { method: 'PUT', headers: { 'Content-Type': mediaType, 'x-upsert': 'true' }, body: file });
      if (!put.ok) throw new ApiError(put.status, 'UPLOAD_TO_STORAGE_FAILED', await put.text().catch(() => undefined));
      let sha256: string | undefined;
      try { const buf = await file.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', buf); sha256 = Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { /* opsional */ }
      return call('POST', '/api/evidence/complete', { ...clean, key: signed.key, media_type: mediaType, sha256 });
    }
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(clean)) fd.append(k, String(v));
    return call('POST', '/api/evidence', fd);
  },
};

export const rupiah = (n: number | string | null | undefined) =>
  n == null ? '-' : 'Rp' + Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 });
export const num = (n: number | string | null | undefined, d = 0) => (n == null ? '-' : Number(n).toLocaleString('id-ID', { maximumFractionDigits: d }));
export const pct = (n: number | string | null | undefined) => (n == null ? '-' : `${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 })}%`);
export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const d = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('id-ID', { dateStyle: 'medium' }) : '-');
export const errMsg = (e: any) => (e instanceof ApiError ? `${e.message}${e.details ? ' — ' + JSON.stringify(e.details) : ''}` : String(e?.message ?? e));

export const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PENDING_PAYMENT: 'Menunggu pembayaran', PAID: 'Dibayar', PACKING: 'Packing', PICKED_UP: 'Diambil kurir', IN_TRANSIT: 'Dalam perjalanan',
  ARRIVED_WAITING_INSPECTION: 'Tiba — menunggu inspeksi', ACCEPTED: 'Diterima', PARTIALLY_ACCEPTED: 'Diterima sebagian', REJECTED: 'Ditolak',
  DISPUTED: 'Dispute', SETTLED: 'Selesai (settled)', CANCELLED: 'Dibatalkan',
};
export const RETURN_STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Diajukan', EVIDENCE_REVIEW: 'Review bukti', APPROVED: 'Disetujui', PARTIALLY_APPROVED: 'Disetujui sebagian', REJECTED: 'Ditolak',
  PICKUP_SCHEDULED: 'Pickup retur', IN_TRANSIT: 'Retur dalam perjalanan', RECEIVED_BY_SUPPLIER: 'Diterima supplier', CLOSED: 'Selesai',
};
export const BATCH_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', UPCOMING: 'Akan panen', PRE_HARVEST_UPDATED: 'Menjelang panen (update)', READY_FOR_ORDER: 'Siap dipesan', SOLD_OUT: 'Habis', CLOSED: 'Ditutup',
};
export const FAULT_LABEL: Record<string, string> = {
  SUPPLIER: 'Supplier', PACKAGING: 'Packaging', LOGISTICS: 'Logistik', BUYER_RECEIVING: 'Penerimaan buyer', OTHER: 'Lainnya', UNDETERMINED: 'Tidak dapat ditentukan',
};

/** Kolom batch yang juga menjadi kunci atribut kategori (ditampilkan sekali saja). */
export const MIRRORED_ATTR_KEYS = ['grade', 'condition', 'size', 'color', 'freshness', 'moisture', 'temperature_c', 'harvest_date', 'availability_date', 'expiry_date', 'shelf_life_days', 'expected_weight_kg'];
/** Baris atribut kategori untuk tampilan: label dari schema, lewati kunci yang sudah tampil sebagai kolom batch. */
export function attributeRows(schema: { key: string; label: string; unit?: string }[] | null | undefined, attrs: Record<string, any> | null | undefined, fmt: (v: any) => any = (v) => v): [string, any][] {
  const sc = schema ?? [];
  return Object.entries(attrs ?? {})
    .filter(([k]) => !MIRRORED_ATTR_KEYS.includes(k))
    .map(([k, v]) => { const f = sc.find((x) => x.key === k); return [f ? `${f.label}${f.unit ? ` (${f.unit})` : ''}` : k, fmt(v)] as [string, any]; });
}
