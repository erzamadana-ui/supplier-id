export interface AuthUser { id: string; email: string; name: string; role: 'ADMIN' | 'SUPPLIER' | 'BUYER'; orgId: string | null }

const TOKEN_KEY = 'supplierid.token';
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
  const r = await fetch(url, { method, headers, body: payload });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error || r.statusText, data?.details);
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => call<T>('GET', url),
  post: <T = any>(url: string, body?: any) => call<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: any) => call<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: any) => call<T>('PATCH', url, body ?? {}),
  /** Unggah bukti foto/video. meta: owner_type, kind, batch_id/order_id, taken_at, lat, lng, location_consent */
  upload: (file: File, meta: Record<string, any>) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null && v !== '') fd.append(k, String(v));
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
