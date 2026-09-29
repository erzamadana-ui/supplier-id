import { ReactNode, useState } from 'react';

/** Judul halaman admin dengan deskripsi dan aksi opsional. */
export function PageHead({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/** Tab sederhana (state internal atau terkendali). */
export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)} type="button">{t.label}</button>
      ))}
    </div>
  );
}

export function useTabs(initial: string) {
  const [tab, setTab] = useState(initial);
  return { tab, setTab };
}

/** JSON ringkas untuk kolom before/after audit log. */
export function JsonCompact({ v, max = 160 }: { v: any; max?: number }) {
  if (v == null) return <span className="muted">-</span>;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return <code title={s.length > max ? s : undefined}>{s.length > max ? s.slice(0, max) + '…' : s}</code>;
}

/** Perubahan before→after: hanya kunci yang berubah. */
export function diffKeys(before: any, after: any): Record<string, [any, any]> {
  const out: Record<string, [any, any]> = {};
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return out;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = [before[k], after[k]];
  }
  return out;
}

export function DiffCell({ before, after }: { before: any; after: any }) {
  const diff = diffKeys(before, after);
  const keys = Object.keys(diff).filter((k) => !['updated_at', 'created_at', 'approved_at'].includes(k));
  if (!keys.length) return <><JsonCompact v={before} max={80} /> → <JsonCompact v={after} max={80} /></>;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {keys.slice(0, 6).map((k) => (
        <div key={k}><code>{k}</code>: <JsonCompact v={diff[k][0]} max={60} /> → <JsonCompact v={diff[k][1]} max={60} /></div>
      ))}
      {keys.length > 6 && <small className="muted">+{keys.length - 6} field lain</small>}
    </div>
  );
}

/** ISO date (YYYY-MM-DD) untuk input type=date. */
export const isoDate = (dte: Date) => dte.toISOString().slice(0, 10);
export const daysAgo = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return x; };

/** Ubah nilai input datetime-local menjadi ISO UTC. */
export const localToIso = (s: string) => (s ? new Date(s).toISOString() : undefined);

export const ORG_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Aktif', WARNING: 'Peringatan', VERIFICATION_REQUIRED: 'Perlu verifikasi', LISTING_LIMITED: 'Listing dibatasi', UNDER_REVIEW: 'Dalam review', SUSPENDED: 'Ditangguhkan',
};
export const ORG_STATUSES = Object.keys(ORG_STATUS_LABEL);
export const ENFORCEMENT_ACTION_LABEL: Record<string, string> = {
  WARNING: 'Peringatan', RANK_DOWN: 'Peringkat diturunkan', ADDITIONAL_VERIFICATION: 'Verifikasi tambahan', LISTING_LIMITED: 'Listing dibatasi', ACCOUNT_REVIEW: 'Review akun',
};
export const SUPPLIER_KIND_LABEL: Record<string, string> = {
  PETANI: 'Petani', KELOMPOK_TANI: 'Kelompok tani', PETERNAK: 'Peternak', NELAYAN: 'Nelayan', KOPERASI: 'Koperasi', DISTRIBUTOR: 'Distributor', PERUSAHAAN: 'Perusahaan',
};
export const FEE_STATUS_LABEL: Record<string, string> = { ACTIVE: 'Aktif', PENDING_APPROVAL: 'Menunggu persetujuan', SUPERSEDED: 'Digantikan', REJECTED: 'Ditolak' };
export const FEE_SCOPES = ['GLOBAL', 'CATEGORY', 'SUPPLIER', 'BUYER', 'CONTRACT', 'PROMOTION', 'VALUE_TIER', 'REGION'];
export const SCOPE_LABEL: Record<string, string> = {
  GLOBAL: 'Global (default)', CATEGORY: 'Per kategori', SUPPLIER: 'Per supplier', BUYER: 'Per buyer', CONTRACT: 'Per kontrak', PROMOTION: 'Per promosi', VALUE_TIER: 'Per tier nilai order', REGION: 'Per wilayah',
};

export const TAX_COMPONENTS = ['PRODUCT', 'PLATFORM_FEE', 'PACKAGING', 'LOGISTICS', 'PAYMENT_FEE', 'OPTIONAL_SERVICE'];
export const COMPONENT_LABEL: Record<string, string> = {
  PRODUCT: 'Produk', PLATFORM_FEE: 'Platform fee', PACKAGING: 'Packaging', LOGISTICS: 'Logistik', PAYMENT_FEE: 'Payment fee', OPTIONAL_SERVICE: 'Layanan opsional',
};

export const ACCOUNT_GROUPS: Record<string, string[]> = {
  Aset: ['CASH', 'LOGISTICS_RECEIVABLE'],
  Liabilitas: ['SUPPLIER_PAYABLE', 'REFUND_PAYABLE', 'LOGISTICS_PAYABLE', 'TAX_PAYABLE'],
  Pendapatan: ['PLATFORM_FEE_REVENUE', 'PACKAGING_REVENUE', 'LOGISTICS_REVENUE', 'OPTIONAL_SERVICE_REVENUE', 'PAYMENT_FEE_COLLECTED'],
  Beban: ['PACKAGING_COST', 'LOGISTICS_COST', 'PAYMENT_PROCESSING_FEE', 'PROMOTION_DISCOUNT', 'RETURN_ADJUSTMENT'],
};
export const ALL_ACCOUNTS = Object.values(ACCOUNT_GROUPS).flat();
export const ACCOUNT_LABEL: Record<string, string> = {
  CASH: 'Kas', LOGISTICS_RECEIVABLE: 'Piutang klaim logistik', SUPPLIER_PAYABLE: 'Utang ke supplier', REFUND_PAYABLE: 'Utang refund buyer', LOGISTICS_PAYABLE: 'Utang ke logistik', TAX_PAYABLE: 'Utang pajak',
  PLATFORM_FEE_REVENUE: 'Pendapatan platform fee', PACKAGING_REVENUE: 'Pendapatan packaging', LOGISTICS_REVENUE: 'Pendapatan logistik', OPTIONAL_SERVICE_REVENUE: 'Pendapatan layanan opsional', PAYMENT_FEE_COLLECTED: 'Payment fee dipungut',
  PACKAGING_COST: 'Beban packaging', LOGISTICS_COST: 'Beban logistik', PAYMENT_PROCESSING_FEE: 'Beban biaya provider pembayaran', PROMOTION_DISCOUNT: 'Beban diskon promo', RETURN_ADJUSTMENT: 'Beban penyesuaian retur',
};

/** Bar horizontal proporsional untuk tabel. */
export function HBar({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0;
  return (
    <div style={{ background: '#eef1ee', borderRadius: 4, height: 10, width: '100%', minWidth: 80 }}>
      <div style={{ background: 'var(--brand)', height: '100%', width: `${w}%`, borderRadius: 4 }} />
    </div>
  );
}

/** Input alasan ringkas yang dipakai berulang. */
export function ReasonInput({ value, onChange, required, placeholder = 'Alasan perubahan (untuk audit log)' }: { value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} />;
}
