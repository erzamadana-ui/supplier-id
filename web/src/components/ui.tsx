import { ReactNode, useEffect, useState } from 'react';
import { errMsg } from '../lib/api';

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <h3>{title}</h3>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'muted' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export const statusTone = (s: string) => {
  if (['SETTLED', 'ACCEPTED', 'READY_FOR_ORDER', 'PAID', 'ACTIVE', 'CLOSED', 'APPROVED'].includes(s)) return 'good';
  if (['REJECTED', 'CANCELLED', 'SUSPENDED', 'UNDER_REVIEW', 'DISPUTED'].includes(s)) return 'bad';
  if (['PARTIALLY_ACCEPTED', 'WARNING', 'LISTING_LIMITED', 'VERIFICATION_REQUIRED', 'EVIDENCE_REVIEW', 'PARTIALLY_APPROVED', 'ARRIVED_WAITING_INSPECTION'].includes(s)) return 'warn';
  return '';
};

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warn'; children: ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Field({ label, children, hint, required }: { label: string; children: ReactNode; hint?: string; required?: boolean }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required && <em> *</em>}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function Money({ v }: { v: number | string | null | undefined }) {
  return <span className="money">{v == null ? '-' : 'Rp' + Number(v).toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span>;
}

/** Tombol dengan state loading + error otomatis. */
export function AsyncButton({ onClick, children, className = 'btn', confirm, disabled }: { onClick: () => Promise<any>; children: ReactNode; className?: string; confirm?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <span className="async-btn">
      <button className={className} disabled={busy || disabled} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true); setErr('');
        try { await onClick(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>{busy ? '…' : children}</button>
      {err && <small className="inline-error">{err}</small>}
    </span>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = async () => { setLoading(true); setError(''); try { setData(await fn()); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); } };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, deps);
  return { data, error, loading, reload, setData };
}

export function Empty({ children = 'Belum ada data.' }: { children?: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Timeline({ items }: { items: { at: string; title: string; note?: string | null }[] }) {
  return (
    <ol className="timeline">
      {items.map((it, i) => (
        <li key={i}><time>{new Date(it.at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}</time><strong>{it.title}</strong>{it.note && <span>{it.note}</span>}</li>
      ))}
    </ol>
  );
}

/** Galeri bukti foto/video. */
export function EvidenceGallery({ files, emptyText = 'Belum ada bukti.' }: { files: any[]; emptyText?: string }) {
  if (!files?.length) return <Empty>{emptyText}</Empty>;
  return (
    <div className="gallery">
      {files.map((f) => (
        <figure key={f.id}>
          {String(f.media_type).startsWith('video/')
            ? <video src={`/uploads/${f.file_path}`} controls />
            : <img src={`/uploads/${f.file_path}`} alt={f.kind} />}
          <figcaption>
            <b>{f.kind}</b><br />
            <small>diambil: {f.taken_at ? new Date(f.taken_at).toLocaleString('id-ID') : '-'}</small><br />
            <small>unggah: {new Date(f.uploaded_at).toLocaleString('id-ID')}</small>
            {f.lat != null && <><br /><small>lokasi: {Number(f.lat).toFixed(4)}, {Number(f.lng).toFixed(4)}</small></>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** Bar chart SVG sederhana tanpa dependensi. */
export function BarChart({ data, valueKey, labelKey, height = 160, format }: { data: any[]; valueKey: string; labelKey: string; height?: number; format?: (v: number) => string }) {
  if (!data?.length) return <Empty />;
  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);
  const w = 100 / data.length;
  return (
    <div className="barchart">
      <svg viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none">
        {data.map((d, i) => {
          const v = Number(d[valueKey]) || 0;
          const h = (v / max) * (height / 4 - 4);
          return <rect key={i} x={i * w + w * 0.15} y={height / 4 - h} width={w * 0.7} height={h} rx="0.5"><title>{`${d[labelKey]}: ${format ? format(v) : v}`}</title></rect>;
        })}
      </svg>
      <div className="barchart-labels">{data.map((d, i) => { const raw = String(d[labelKey]); const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/); const lbl = m ? `${m[3]}/${m[2]}` : raw.slice(0, 6); return <span key={i} title={raw}>{data.length > 12 && i % 3 !== 0 ? '' : lbl}</span>; })}</div>
    </div>
  );
}

export function JsonEditor({ value, onSave, rows = 10 }: { value: any; onSave: (v: any) => Promise<void>; rows?: number }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [err, setErr] = useState('');
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <div className="json-editor">
      <textarea rows={rows} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row">
        <AsyncButton onClick={async () => { let v; try { v = JSON.parse(text); } catch { setErr('JSON tidak valid'); return; } setErr(''); await onSave(v); }}>Simpan</AsyncButton>
        {err && <small className="inline-error">{err}</small>}
      </div>
    </div>
  );
}
