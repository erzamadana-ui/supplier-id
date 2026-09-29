/** Helper bersama untuk halaman buyer + halaman order/retur lintas peran. */
import { ReactNode, useEffect, useState } from 'react';
import { num, pct, rupiah } from '../../lib/api';

export interface AttrField { key: string; label: string; type?: string; required?: boolean; options?: string[]; unit?: string }

export const COMPONENT_LABEL: Record<string, string> = {
  PRODUCT: 'Produk', PLATFORM_FEE: 'Platform fee', PACKAGING: 'Packaging', LOGISTICS: 'Delivery', PAYMENT_FEE: 'Payment fee', OPTIONAL_SERVICE: 'Layanan opsional',
};
export const BEARER_LABEL: Record<string, string> = { SUPPLIER: 'Supplier', PLATFORM: 'Platform', LOGISTICS: 'Penyedia logistik', BUYER: 'Buyer' };
export const OPTIONAL_SERVICES = [
  { code: 'INSURANCE', label: 'Asuransi pengiriman' },
  { code: 'COLD_CHAIN', label: 'Cold chain' },
  { code: 'HANDLING', label: 'Additional handling' },
];

/** Label atribut dinamis dari attribute_schema kategori. */
export function attrLabel(schema: AttrField[] | undefined | null, key: string) {
  const f = (schema ?? []).find((x) => x.key === key);
  return f ? (f.unit ? `${f.label} (${f.unit})` : f.label) : key;
}

/** Hapus string kosong/undefined dari payload (zod optional tidak menerima ''). */
export function compact<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '-'}</dd></div>
      ))}
    </dl>
  );
}

export function fmtVal(v: any): ReactNode {
  if (v == null || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'Ya' : 'Tidak';
  if (typeof v === 'number') return num(v, 3);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return new Date(v).toLocaleDateString('id-ID', { dateStyle: 'medium' });
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Rincian pajak per komponen (dapat dibuka/tutup). */
export function TaxLines({ lines }: { lines: any[] }) {
  if (!lines?.length) return <small className="muted">Tidak ada rincian pajak.</small>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Komponen</th><th>Aturan</th><th className="num">Dasar</th><th className="num">Tarif</th><th className="num">Pajak</th><th>Kena pajak</th></tr></thead>
        <tbody>
          {lines.map((t, i) => (
            <tr key={i}>
              <td>{COMPONENT_LABEL[t.component] ?? t.component}</td>
              <td><small>{t.rule}</small></td>
              <td className="num">{rupiah(t.base)}</td>
              <td className="num">{pct(t.rate)}</td>
              <td className="num">{rupiah(t.amount)}</td>
              <td>{t.taxable ? 'Ya' : 'Tidak'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface SummaryModel {
  productValue: number; quantity?: number; unit?: string; unitPrice?: number;
  platformFeeRate: number | null; platformFeeAmount: number; packagingAmount: number; logisticsAmount: number; paymentFeeAmount: number;
  optionalAmount: number; optionalLines: { code: string; label: string; amount: number }[];
  discountAmount: number; discountLine?: { code: string; label: string } | null;
  taxAmount: number; taxLines: any[]; totalAmount: number;
}

/** Tabel ORDER SUMMARY transparan — dipakai di preview listing dan detail order. */
export function SummaryTable({ m }: { m: SummaryModel }) {
  const [showTax, setShowTax] = useState(false);
  return (
    <>
      <table className="summary">
        <tbody>
          <tr>
            <td>Products{m.quantity != null && <small className="muted"> — {num(m.quantity, 3)} {m.unit ?? ''} × {rupiah(m.unitPrice)}</small>}</td>
            <td>{rupiah(m.productValue)}</td>
          </tr>
          <tr><td>Supplier.id Platform Fee <small className="muted">({pct(m.platformFeeRate)})</small></td><td>{rupiah(m.platformFeeAmount)}</td></tr>
          <tr><td>Packaging</td><td>{rupiah(m.packagingAmount)}</td></tr>
          <tr><td>Delivery</td><td>{rupiah(m.logisticsAmount)}</td></tr>
          <tr><td>Payment Fee</td><td>{rupiah(m.paymentFeeAmount)}</td></tr>
          {(m.optionalLines ?? []).map((l) => (
            <tr key={l.code}><td>Optional service — {l.label}</td><td>{rupiah(l.amount)}</td></tr>
          ))}
          {!(m.optionalLines ?? []).length && <tr><td>Optional services</td><td>{rupiah(m.optionalAmount ?? 0)}</td></tr>}
          <tr>
            <td>
              Tax{' '}
              <button type="button" className="btn secondary small" onClick={() => setShowTax((s) => !s)}>{showTax ? 'Tutup rincian' : 'Lihat rincian'}</button>
            </td>
            <td>{rupiah(m.taxAmount)}</td>
          </tr>
          {showTax && <tr><td colSpan={2}><TaxLines lines={m.taxLines} /></td></tr>}
          {Number(m.discountAmount) > 0 && (
            <tr className="discount"><td>Discount{m.discountLine ? ` — ${m.discountLine.label} (${m.discountLine.code})` : ''}</td><td>−{rupiah(m.discountAmount)}</td></tr>
          )}
          <tr className="total"><td>TOTAL PAYMENT</td><td>{rupiah(m.totalAmount)}</td></tr>
        </tbody>
      </table>
      <small className="muted">Tidak ada biaya tersembunyi.</small>
    </>
  );
}

/** Tabs sederhana. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={t.key === value ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}{t.count != null && <small> ({t.count})</small>}
        </button>
      ))}
    </div>
  );
}

/** Timeline shipment event → item Timeline UI. */
export function shipmentEventItems(events: any[] | null | undefined) {
  return (events ?? []).map((e) => ({
    at: e.occurred_at,
    title: [e.event_type, e.location ? `@ ${e.location}` : null, e.temperature_c != null ? `${num(e.temperature_c, 1)}°C` : null].filter(Boolean).join(' · '),
    note: e.note,
  }));
}

/** Nilai yang tertunda (debounce) — untuk preview harga saat input berubah. */
export function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
