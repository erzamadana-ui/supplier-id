import { ReactNode, useEffect, useState } from 'react';
import { api, dt, errMsg, FAULT_LABEL } from '../../lib/api';
import { Card, Badge, Alert, AsyncButton, Empty, useAsync, JsonEditor } from '../../components/ui';
import { PageHead, Tabs, useTabs, COMPONENT_LABEL } from './shared';

type SettingRow = { key: string; value: any; description?: string | null; updated_at?: string | null; updated_by?: string | null };
type Saver = (key: string, value: any, reason?: string) => Promise<void>;

const FAULTS = ['SUPPLIER', 'PACKAGING', 'LOGISTICS', 'BUYER_RECEIVING', 'OTHER', 'UNDETERMINED'];
const POLICY_COMPONENTS = ['PRODUCT', 'PLATFORM_FEE', 'PACKAGING', 'LOGISTICS', 'OPTIONAL_SERVICE', 'PAYMENT_FEE'];
const MODES = ['FULL', 'PRORATA', 'NONE'];
const BEARERS = ['SUPPLIER', 'BUYER', 'PLATFORM', 'LOGISTICS'];
const EVIDENCE_KINDS = ['OVERALL', 'CLOSEUP', 'PACKAGING'];
const ENFORCEMENT_LEVELS: [string, string][] = [
  ['warning', 'Peringatan'], ['rank_down', 'Peringkat diturunkan'], ['verification_required', 'Verifikasi tambahan'], ['listing_limited', 'Listing dibatasi'], ['under_review', 'Review akun'],
];

const DESC: Record<string, { label: string; hint: string; unit?: string; step?: string }> = {
  'packaging.rate_per_kg': { label: 'Tarif packaging per kg', hint: 'Ditagihkan ke buyer (Rp/kg); kategori bisa menimpa lewat packaging_rate_per_unit', unit: 'Rp/kg' },
  'packaging.cost_ratio': { label: 'Rasio biaya packaging', hint: 'Estimasi biaya sebagai rasio dari packaging revenue (margin = 1 − rasio)', step: '0.01' },
  'logistics.base_fee': { label: 'Biaya dasar logistik', hint: 'Biaya tetap per pengiriman', unit: 'Rp' },
  'logistics.rate_per_km': { label: 'Tarif per km', hint: 'Dikalikan distance_km order', unit: 'Rp/km' },
  'logistics.rate_per_kg': { label: 'Tarif per kg', hint: 'Dikalikan berat order', unit: 'Rp/kg' },
  'logistics.cost_ratio': { label: 'Rasio biaya logistik', hint: 'Biaya ke penyedia logistik sebagai rasio dari logistics revenue', step: '0.01' },
  'logistics.return_cost_ratio': { label: 'Rasio biaya retur', hint: 'Biaya return pickup sebagai rasio dari biaya logistik awal', step: '0.01' },
  'fulfillment.pickup_lead_hours': { label: 'Lead time pickup', hint: 'Batas jam sejak pembayaran sampai pickup; lewat = late fulfillment', unit: 'jam' },
  'payment.fee_percent': { label: 'Payment fee ke buyer (%)', hint: 'Persentase dari total yang ditagihkan ke buyer', step: '0.01', unit: '%' },
  'payment.fee_fixed': { label: 'Payment fee tetap', hint: 'Rp per transaksi ditagihkan ke buyer', unit: 'Rp' },
  'payment.provider_fee_percent': { label: 'Biaya provider (%)', hint: 'Dipotong provider dari platform', step: '0.01', unit: '%' },
  'payment.provider_fee_fixed': { label: 'Biaya provider tetap', hint: 'Rp per transaksi', unit: 'Rp' },
  'evidence.min_photos': { label: 'Minimum foto deklarasi', hint: 'Per batch (kategori bisa menimpa lewat min_photos)', unit: 'foto' },
  'harvest.pre_harvest_reminder_days': { label: 'Pengingat pre-harvest', hint: 'Sistem meminta pre-harvest update H-n sebelum panen', unit: 'hari' },
  'return.claim_window_hours': { label: 'Batas waktu klaim', hint: 'Sejak barang tiba (arrived)', unit: 'jam' },
  'confirmation.window_hours': { label: 'Jendela konfirmasi penerimaan', hint: 'confirmation_due_at = delivered_at (bukti sah) + n jam, waktu server', unit: 'jam' },
  'payment.expiry_hours': { label: 'Kedaluwarsa pembayaran', hint: 'Order induk PENDING_PAYMENT lewat n jam → EXPIRED, stok dilepas (job)', unit: 'jam' },
  'payout.sla_hours': { label: 'SLA payout', hint: 'Payment task belum PAID lewat n jam sejak dibuat → ditandai terlambat di dashboard ops', unit: 'jam' },
  'supplier.response_hours': { label: 'Batas respons mitra', hint: 'Task ACCEPTANCE tanpa respons lewat n jam → LATE + eskalasi SUPPLIER_LATE', unit: 'jam' },
  'delivery.max_attempts': { label: 'Maksimum percobaan antar', hint: 'Setelah n gagal antar → eskalasi DELIVERY_FAILED (kirim ulang/batal oleh ops)', unit: 'kali' },
};

/** Pratinjau & purge data uji (org "UJI …" / email uji-*@supplier.id) — transaksional, ledger tetap seimbang. */
function TestDataPanel() {
  const preview = useAsync(() => api.get('/api/admin/test-data'), []);
  const [result, setResult] = useState<any>(null);
  const [confirm, setConfirm] = useState('');
  const d = preview.data;
  return (
    <div className="grid cols-2">
      <Card title="Data uji yang terdeteksi">
        {preview.loading && <p>Memuat…</p>}
        {preview.error && <Alert kind="error">{preview.error}</Alert>}
        {d && (!d.organizations.length ? <Empty>Tidak ada data uji. Database bersih.</Empty> : (
          <>
            <p>{d.organizations.length} organisasi · {d.orders} order · {d.evidence_files} berkas bukti · {d.ledger_journals} jurnal ledger</p>
            <ul>{d.organizations.map((o: any) => <li key={o.id}><Badge>{o.type}</Badge> {o.name}</li>)}</ul>
          </>
        ))}
      </Card>
      <Card title="Hapus data uji">
        <p className="muted"><small>Menghapus organisasi uji beserta user, produk, batch, order, bukti (termasuk objek di Storage), ledger, payout, dan override fee-nya dalam satu transaksi. Data produksi lain tidak disentuh. Ketik <code>HAPUS DATA UJI</code> untuk konfirmasi.</small></p>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="HAPUS DATA UJI" />
        <div style={{ marginTop: 8 }}>
          <AsyncButton className="btn danger" disabled={confirm !== 'HAPUS DATA UJI' || !d?.organizations?.length} confirm="Hapus seluruh data uji sekarang? Tindakan ini permanen."
            onClick={async () => { setResult(await api.post('/api/admin/test-data/purge', { confirm })); setConfirm(''); await preview.reload(); }}>
            Hapus data uji
          </AsyncButton>
        </div>
        {result && <Alert kind="success">Terhapus: {result.organizations} organisasi, {result.orders} order, {result.evidence_files} bukti ({result.storage_objects} objek Storage). Rekonsiliasi: {result.reconciliation?.balanced ? 'seimbang' : 'TIDAK SEIMBANG'}.</Alert>}
      </Card>
    </div>
  );
}

function SettingMeta({ row }: { row?: SettingRow }) {
  if (!row) return <small className="muted">Belum ada di database — akan dibuat saat disimpan.</small>;
  return <small className="muted">{row.description ? row.description + ' · ' : ''}diperbarui {dt(row.updated_at)}</small>;
}

function NumberSetting({ k, row, save }: { k: string; row?: SettingRow; save: Saver }) {
  const meta = DESC[k] ?? { label: k, hint: '' };
  const [v, setV] = useState(String(row?.value ?? ''));
  const [reason, setReason] = useState('');
  useEffect(() => setV(String(row?.value ?? '')), [row?.value]);
  const dirty = String(row?.value ?? '') !== v;
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row between">
        <div><b>{meta.label}</b> <code>{k}</code><br /><small className="muted">{meta.hint}</small></div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input type="number" step={meta.step ?? 'any'} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 160 }} />
        {meta.unit && <span className="muted">{meta.unit}</span>}
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Alasan (opsional)" style={{ width: 260 }} />
        <AsyncButton className="btn small" disabled={!dirty || v === ''} onClick={async () => { await save(k, Number(v), reason || undefined); setReason(''); }}>Simpan</AsyncButton>
      </div>
      <SettingMeta row={row} />
    </div>
  );
}

function BoolSetting({ k, label, hint, row, save }: { k: string; label: string; hint: string; row?: SettingRow; save: Saver }) {
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <label className="row">
        <input type="checkbox" checked={!!row?.value} onChange={(e) => save(k, e.target.checked, `${label}: ${e.target.checked ? 'aktif' : 'nonaktif'}`)} />
        <span><b>{label}</b> <code>{k}</code><br /><small className="muted">{hint}</small></span>
      </label>
      <SettingMeta row={row} />
    </div>
  );
}

function ChoiceSetting({ k, label, hint, options, row, save }: { k: string; label: string; hint: string; options: string[]; row?: SettingRow; save: Saver }) {
  const [reason, setReason] = useState('');
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div><b>{label}</b> <code>{k}</code><br /><small className="muted">{hint}</small></div>
      <div className="row" style={{ marginTop: 8 }}>
        <select value={String(row?.value ?? options[0])} onChange={(e) => save(k, e.target.value, reason || `${label} → ${e.target.value}`)}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Alasan (opsional)" style={{ width: 260 }} />
      </div>
      <SettingMeta row={row} />
    </div>
  );
}

function SaveBar({ dirty, onSave, children }: { dirty: boolean; onSave: (reason?: string) => Promise<void>; children?: ReactNode }) {
  const [reason, setReason] = useState('');
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Alasan perubahan (opsional)" style={{ width: 300 }} />
      <AsyncButton className="btn" disabled={!dirty} onClick={async () => { await onSave(reason || undefined); setReason(''); }}>Simpan</AsyncButton>
      {children}
    </div>
  );
}

function RequiredKinds({ row, save }: { row?: SettingRow; save: Saver }) {
  const cur: string[] = Array.isArray(row?.value) ? row!.value : [];
  const [v, setV] = useState<string[]>(cur);
  useEffect(() => setV(cur), [row?.value]);
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <b>Jenis foto wajib deklarasi</b> <code>evidence.required_kinds</code><br />
      <small className="muted">Batch tidak bisa dipublikasikan sebelum semua jenis foto ini ada.</small>
      <div className="row" style={{ marginTop: 8 }}>
        {EVIDENCE_KINDS.map((kd) => (
          <label key={kd} className="row"><input type="checkbox" checked={v.includes(kd)} onChange={(e) => setV(e.target.checked ? [...v, kd] : v.filter((x) => x !== kd))} /> {kd}</label>
        ))}
      </div>
      <SaveBar dirty={dirty} onSave={(r) => save('evidence.required_kinds', EVIDENCE_KINDS.filter((x) => v.includes(x)), r)} />
      <SettingMeta row={row} />
    </div>
  );
}

function ReturnPolicyMatrix({ row, save }: { row?: SettingRow; save: Saver }) {
  const cur = row?.value && typeof row.value === 'object' ? row.value : {};
  const [p, setP] = useState<any>(JSON.parse(JSON.stringify(cur)));
  useEffect(() => setP(JSON.parse(JSON.stringify(cur))), [row?.value]);
  const dirty = JSON.stringify(p) !== JSON.stringify(cur);
  const set = (rowKey: string, fault: string, val: string) => setP({ ...p, [rowKey]: { ...(p[rowKey] ?? {}), [fault]: val } });
  const modeTone = (m: string) => (m === 'FULL' ? 'bad' : m === 'PRORATA' ? 'warn' : 'good');
  return (
    <Card title={<>Matriks refund per komponen × atribusi penyebab <code>return.policy</code></>}>
      <p className="muted">FULL = komponen dikembalikan penuh, PRORATA = proporsional jumlah disetujui, NONE = tidak dikembalikan. Baris penanggung menentukan siapa menanggung kerugian produk dan biaya logistik retur.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Komponen</th>{FAULTS.map((f) => <th key={f}>{FAULT_LABEL[f] ?? f}</th>)}</tr></thead>
          <tbody>
            {POLICY_COMPONENTS.map((c) => (
              <tr key={c}>
                <td><b>{COMPONENT_LABEL[c] ?? c}</b><br /><small className="muted">{c}</small></td>
                {FAULTS.map((f) => (
                  <td key={f}>
                    <select value={p[c]?.[f] ?? 'NONE'} onChange={(e) => set(c, f, e.target.value)} className={`badge ${modeTone(p[c]?.[f] ?? 'NONE')}`} style={{ width: 'auto', padding: '4px 6px' }}>
                      {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
            {[['product_loss_bearer', 'Penanggung kerugian produk'], ['return_logistics_bearer', 'Penanggung logistik retur']].map(([k, label]) => (
              <tr key={k} style={{ background: '#fafbfa' }}>
                <td><b>{label}</b><br /><small className="muted">{k}</small></td>
                {FAULTS.map((f) => (
                  <td key={f}>
                    <select value={p[k]?.[f] ?? 'PLATFORM'} onChange={(e) => set(k, f, e.target.value)} style={{ width: 'auto', padding: '4px 6px' }}>
                      {BEARERS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SaveBar dirty={dirty} onSave={(r) => save('return.policy', p, r)}>
        <button className="btn secondary" type="button" disabled={!dirty} onClick={() => setP(JSON.parse(JSON.stringify(cur)))}>Batalkan perubahan</button>
      </SaveBar>
      <SettingMeta row={row} />
    </Card>
  );
}

function QualityWeights({ row, save }: { row?: SettingRow; save: Saver }) {
  const cur = row?.value && typeof row.value === 'object' ? row.value : {};
  const [w, setW] = useState<Record<string, string>>(Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, String(v)])));
  useEffect(() => setW(Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, String(v)]))), [row?.value]);
  const total = Object.values(w).reduce((a, b) => a + (Number(b) || 0), 0);
  const asObj = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v) || 0]));
  const dirty = JSON.stringify(asObj) !== JSON.stringify(cur);
  const LABEL: Record<string, string> = {
    acceptance_rate: 'Tingkat penerimaan buyer', return_rate: 'Tingkat retur (invers)', damage_rate: 'Tingkat kerusakan (invers)', quality_mismatch: 'Ketidaksesuaian kualitas (invers)', weight_mismatch: 'Ketidaksesuaian berat (invers)',
    late_fulfillment: 'Keterlambatan pemenuhan (invers)', cancellation: 'Pembatalan (invers)', dispute_history: 'Riwayat dispute (invers)', declaration_accuracy: 'Akurasi deklarasi',
  };
  return (
    <Card title={<>Bobot Quality Score <code>quality.weights</code></>}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Metrik</th><th>Kunci</th><th className="num">Bobot</th></tr></thead>
          <tbody>
            {Object.keys(w).map((k) => (
              <tr key={k}><td>{LABEL[k] ?? k}</td><td><code>{k}</code></td><td className="num"><input type="number" step="1" min="0" value={w[k]} onChange={(e) => setW({ ...w, [k]: e.target.value })} style={{ width: 90 }} /></td></tr>
            ))}
            <tr className="total"><td>Total</td><td></td><td className="num"><Badge tone={total === 100 ? 'good' : 'bad'}>{total} / 100</Badge></td></tr>
          </tbody>
        </table>
      </div>
      {total !== 100 && <Alert kind="warn">Total bobot harus 100 agar skor berada pada skala 0–100.</Alert>}
      <SaveBar dirty={dirty && total === 100} onSave={(r) => save('quality.weights', asObj, r)} />
      <SettingMeta row={row} />
    </Card>
  );
}

function QualityEnforcement({ row, save }: { row?: SettingRow; save: Saver }) {
  const cur = row?.value && typeof row.value === 'object' ? row.value : {};
  const [e, setE] = useState<any>(JSON.parse(JSON.stringify(cur)));
  useEffect(() => setE(JSON.parse(JSON.stringify(cur))), [row?.value]);
  const dirty = JSON.stringify(e) !== JSON.stringify(cur);
  const thresholds = ENFORCEMENT_LEVELS.map(([k]) => Number(e[k]?.return_rate_gt ?? 0));
  const monotonic = thresholds.every((t, i) => i === 0 || t >= thresholds[i - 1]);
  return (
    <Card title={<>Ambang enforcement supplier <code>quality.enforcement</code></>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="field" style={{ width: 220 }}>
          <span className="field-label">Minimum order sebelum enforcement</span>
          <input type="number" min="0" step="1" value={e.min_orders ?? 0} onChange={(ev) => setE({ ...e, min_orders: Number(ev.target.value) })} />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Level</th><th>Kunci</th><th className="num">Return rate &gt; (%)</th></tr></thead>
          <tbody>
            {ENFORCEMENT_LEVELS.map(([k, label]) => (
              <tr key={k}>
                <td>{label}</td><td><code>{k}</code></td>
                <td className="num"><input type="number" step="0.1" min="0" max="100" value={e[k]?.return_rate_gt ?? ''} onChange={(ev) => setE({ ...e, [k]: { ...(e[k] ?? {}), return_rate_gt: Number(ev.target.value) } })} style={{ width: 100 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!monotonic && <Alert kind="warn">Ambang sebaiknya naik dari peringatan ke review akun; urutan saat ini tidak monoton.</Alert>}
      <SaveBar dirty={dirty} onSave={(r) => save('quality.enforcement', e, r)} />
      <SettingMeta row={row} />
    </Card>
  );
}

function JsonSetting({ k, title, hint, row, save, rows = 12 }: { k: string; title: string; hint: string; row?: SettingRow; save: Saver; rows?: number }) {
  const [reason, setReason] = useState('');
  return (
    <Card title={<>{title} <code>{k}</code></>}>
      <p className="muted">{hint}</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Alasan perubahan (opsional)" style={{ marginBottom: 8, maxWidth: 400 }} />
      <JsonEditor value={row?.value ?? null} rows={rows} onSave={async (v) => { await save(k, v, reason || undefined); setReason(''); }} />
      <SettingMeta row={row} />
    </Card>
  );
}

export default function Settings() {
  const settings = useAsync<SettingRow[]>(() => api.get('/api/admin/settings'));
  const { tab, setTab } = useTabs('packaging');
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const map: Record<string, SettingRow> = Object.fromEntries((settings.data ?? []).map((r) => [r.key, r]));

  const save: Saver = async (key, value, reason) => {
    setErr(''); setFlash('');
    try {
      const r = await api.put(`/api/admin/settings/${key}`, { value, reason });
      settings.setData((settings.data ?? []).some((x) => x.key === key) ? (settings.data ?? []).map((x) => (x.key === key ? r : x)) : [...(settings.data ?? []), r]);
      setFlash(`${key} tersimpan (${dt(r.updated_at)}).`);
    } catch (e) { setErr(errMsg(e)); throw e; }
  };

  const TABS = [
    { key: 'packaging', label: 'Packaging & Logistik' }, { key: 'payment', label: 'Payment' }, { key: 'evidence', label: 'Bukti & Deklarasi' },
    { key: 'return', label: 'Retur & Refund policy' }, { key: 'v2', label: 'Fulfillment & Payout (v2)' }, { key: 'quality', label: 'Quality Score' }, { key: 'promo', label: 'Layanan opsional & Promo' }, { key: 'all', label: 'Semua (JSON)' }, { key: 'testdata', label: 'Data uji' },
  ];

  return (
    <>
      <PageHead title="Konfigurasi sistem" desc="Semua parameter bisnis tersimpan sebagai setting bernama; perubahan tercatat di audit log dan berlaku untuk order baru." />
      {settings.loading && <p>Memuat…</p>}
      {settings.error && <Alert kind="error">{settings.error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      {err && <Alert kind="error">{err}</Alert>}
      {settings.data && (
        <>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />

          {tab === 'packaging' && (
            <div className="grid cols-2">
              <div>
                <h2>Packaging</h2>
                {['packaging.rate_per_kg', 'packaging.cost_ratio'].map((k) => <NumberSetting key={k} k={k} row={map[k]} save={save} />)}
                <h2>Fulfillment</h2>
                <NumberSetting k="fulfillment.pickup_lead_hours" row={map['fulfillment.pickup_lead_hours']} save={save} />
              </div>
              <div>
                <h2>Logistik</h2>
                {['logistics.base_fee', 'logistics.rate_per_km', 'logistics.rate_per_kg', 'logistics.cost_ratio', 'logistics.return_cost_ratio'].map((k) => <NumberSetting key={k} k={k} row={map[k]} save={save} />)}
              </div>
            </div>
          )}

          {tab === 'payment' && (
            <div className="grid cols-2">
              <div>
                <h2>Ditagihkan ke buyer</h2>
                {['payment.fee_percent', 'payment.fee_fixed'].map((k) => <NumberSetting key={k} k={k} row={map[k]} save={save} />)}
                <BoolSetting k="payment.fee_refundable" label="Payment fee dikembalikan saat refund" hint="Mengikuti aturan provider pembayaran; jika nonaktif, fee tidak masuk refund." row={map['payment.fee_refundable']} save={save} />
              </div>
              <div>
                <h2>Biaya provider (beban platform)</h2>
                {['payment.provider_fee_percent', 'payment.provider_fee_fixed'].map((k) => <NumberSetting key={k} k={k} row={map[k]} save={save} />)}
              </div>
            </div>
          )}

          {tab === 'evidence' && (
            <div className="grid cols-2">
              <div>
                <NumberSetting k="evidence.min_photos" row={map['evidence.min_photos']} save={save} />
                <RequiredKinds row={map['evidence.required_kinds']} save={save} />
              </div>
              <div>
                <BoolSetting k="evidence.location_optional" label="Metadata lokasi opsional" hint="Lokasi hanya disimpan bila pengguna menyetujui (location_consent)." row={map['evidence.location_optional']} save={save} />
                <NumberSetting k="harvest.pre_harvest_reminder_days" row={map['harvest.pre_harvest_reminder_days']} save={save} />
              </div>
            </div>
          )}

          {tab === 'v2' && (
            <div className="grid cols-2">
              <div>
                <h2>Konfirmasi penerimaan</h2>
                <NumberSetting k="confirmation.window_hours" row={map['confirmation.window_hours']} save={save} />
                <BoolSetting k="confirmation.auto_confirm_enabled" label="Auto-confirm setelah jendela berakhir" hint="Hanya bila pelanggan menyetujui di checkout, bukti pengiriman valid (OTP/verifikasi ops), pembayaran PAID, tanpa klaim/hold. Keputusan bisnis 4 Okt 2026: aktif." row={map['confirmation.auto_confirm_enabled']} save={save} />
                <BoolSetting k="confirmation.require_valid_evidence" label="Wajib bukti sah untuk mulai jendela" hint="delivered_at hanya dari OTP penerima atau foto kurir yang diverifikasi ops; tanpa bukti → eskalasi, dana tidak dilepas." row={map['confirmation.require_valid_evidence']} save={save} />
                <h2>Pengiriman</h2>
                <BoolSetting k="delivery.otp_required" label="OTP wajib saat serah terima" hint="Nonaktif = kurir cukup foto + nama penerima, lalu ops memverifikasi bukti." row={map['delivery.otp_required']} save={save} />
                <NumberSetting k="delivery.max_attempts" row={map['delivery.max_attempts']} save={save} />
                <NumberSetting k="supplier.response_hours" row={map['supplier.response_hours']} save={save} />
                <NumberSetting k="payment.expiry_hours" row={map['payment.expiry_hours']} save={save} />
              </div>
              <div>
                <h2>Payout mitra</h2>
                <ChoiceSetting k="payout.provider" label="Provider payout" hint="NONE = transfer manual oleh finance + catat bukti bank; MOCK = sandbox (uji alur PROCESSING→inquiry→PAID). Provider nyata belum terpasang." options={['NONE', 'MOCK']} row={map['payout.provider']} save={save} />
                <BoolSetting k="payout.maker_checker_required" label="Maker–checker wajib" hint="Pengajuan (maker) dan persetujuan (checker) harus dua akun berbeda; ditegakkan server." row={map['payout.maker_checker_required']} save={save} />
                <NumberSetting k="payout.sla_hours" row={map['payout.sla_hours']} save={save} />
                <h2>Model dagang</h2>
                <ChoiceSetting k="trade.platform_tax_status" label="Status pajak platform" hint="PKP = PPN atas margin reseller dihitung; NON_PKP = tidak. Per kategori: MARKETPLACE (fee 15%) atau RESELLER (markup) di menu Kategori." options={['NON_PKP', 'PKP']} row={map['trade.platform_tax_status']} save={save} />
              </div>
            </div>
          )}

          {tab === 'return' && (
            <>
              <div className="grid cols-2">
                <NumberSetting k="return.claim_window_hours" row={map['return.claim_window_hours']} save={save} />
                <BoolSetting k="return.require_video" label="Klaim wajib video" hint="Selain foto, buyer wajib mengunggah video penerimaan untuk klaim retur." row={map['return.require_video']} save={save} />
              </div>
              <ReturnPolicyMatrix row={map['return.policy']} save={save} />
            </>
          )}

          {tab === 'quality' && (
            <div className="grid cols-2">
              <QualityWeights row={map['quality.weights']} save={save} />
              <QualityEnforcement row={map['quality.enforcement']} save={save} />
            </div>
          )}

          {tab === 'promo' && (
            <div className="grid cols-2">
              <JsonSetting k="optional_services" title="Layanan opsional" hint="Array {code,label,mode:PERCENT_OF_PRODUCT|PER_KG|FIXED,value}. Dipilih buyer saat membuat order." row={map['optional_services']} save={save} />
              <JsonSetting k="promotions" title="Kode promo" hint="Array {code,label,mode,value,max?,active}. Diskon ditanggung platform (beban PROMOTION_DISCOUNT)." row={map['promotions']} save={save} />
            </div>
          )}

          {tab === 'testdata' && <TestDataPanel />}

          {tab === 'all' && (
            <Card title="Semua setting (raw JSON)">
              {!settings.data.length ? <Empty /> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th style={{ width: 240 }}>Kunci</th><th>Nilai</th><th style={{ width: 170 }}>Diperbarui</th></tr></thead>
                    <tbody>
                      {settings.data.map((r) => (
                        <tr key={r.key}>
                          <td><code>{r.key}</code><br /><small className="muted">{r.description}</small></td>
                          <td><JsonEditor value={r.value} rows={typeof r.value === 'object' && r.value !== null ? 6 : 1} onSave={(v) => save(r.key, v, 'Ubah via editor JSON')} /></td>
                          <td><small>{dt(r.updated_at)}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </>
      )}
      <p className="footer-note">Perubahan setting tidak mengubah order yang sudah dikonfirmasi (pricing snapshot). Setting <code>fee.change_requires_approval</code> dikelola di halaman Fees.</p>
    </>
  );
}
