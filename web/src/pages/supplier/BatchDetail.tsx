import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, rupiah, num, dt, d, errMsg, ApiError, BATCH_STATUS_LABEL } from '../../lib/api';
import { Card, Badge, statusTone, Alert, Field, Empty, EvidenceGallery, useAsync } from '../../components/ui';
import { AttributeInputs, AttrField, attributeLabel, compact, nowLocal, toDateInput, BATCH_TYPE_LABEL, HARVEST_STAGE_LABEL, PHOTO_KIND_LABEL, OWNER_TYPE_LABEL, FIELD_LABEL } from './shared';

const UNITS = ['KG', 'TON', 'IKAT', 'KARUNG', 'BOX', 'PCS', 'LITER'];

// ---------- Progress strip ----------
function Steps({ batch }: { batch: any }) {
  const r = batch.readiness ?? {};
  const st: string = batch.status;
  const photosOk = Number(r.photos) >= Number(r.min_photos) && (r.missing_photo_kinds ?? []).length === 0;
  const dataOk = (r.missing_fields ?? []).length === 0;
  const published = st !== 'DRAFT';
  const stage: string | undefined = batch.harvest?.stage;
  const cls = (done: boolean, now: boolean) => (done ? 'done' : now ? 'now' : '');
  if (batch.type === 'HARVEST') {
    const final = st === 'READY_FOR_ORDER' || st === 'SOLD_OUT' || st === 'CLOSED' || stage === 'FINAL';
    const pre = stage === 'PRE_HARVEST_UPDATED' || final;
    return (
      <div className="steps">
        <span className={cls(dataOk || published, !dataOk && !published)}>1. Data barang</span>
        <span className={cls(photosOk || published, dataOk && !photosOk && !published)}>2. Foto kondisi saat ini</span>
        <span className={cls(published, dataOk && photosOk && !published)}>3. Deklarasi &amp; jaminan retur</span>
        <span className={cls(pre, published && !pre)}>4. Akan panen</span>
        <span className={cls(final, pre && !final)}>5. Pre-harvest update</span>
        <span className={cls(final, pre && !final)}>6. Deklarasi final (foto hasil panen)</span>
        <span className={cls(final, false)}>7. Siap dipesan</span>
      </div>
    );
  }
  return (
    <div className="steps">
      <span className={cls(dataOk || published, !dataOk && !published)}>1. Data barang</span>
      <span className={cls(photosOk || published, dataOk && !photosOk && !published)}>2. Foto bukti</span>
      <span className={cls(published, dataOk && photosOk && !published)}>3. Deklarasi &amp; jaminan retur</span>
      <span className={cls(published, false)}>4. Terpublikasi / siap dipesan</span>
    </div>
  );
}

// ---------- Data deklarasi ----------
function DeclarationData({ batch, reload }: { batch: any; reload: () => Promise<void> }) {
  const editable = batch.status === 'DRAFT';
  const schema: AttrField[] = batch.attribute_schema ?? [];
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<any>({});
  const [attrs, setAttrs] = useState<Record<string, any>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const start = () => {
    setF({
      grade: batch.grade ?? '', quantity: batch.quantity ?? '', unit: batch.unit ?? 'KG', expected_weight_kg: batch.expected_weight_kg ?? '', weight_tolerance_pct: batch.weight_tolerance_pct ?? '',
      harvest_date: toDateInput(batch.harvest_date), availability_date: toDateInput(batch.availability_date), condition: batch.condition ?? '', size: batch.size ?? '', color: batch.color ?? '',
      freshness: batch.freshness ?? '', moisture: batch.moisture ?? '', temperature_c: batch.temperature_c ?? '', shelf_life_days: batch.shelf_life_days ?? '', expiry_date: toDateInput(batch.expiry_date),
      price_per_unit: batch.price_per_unit ?? '',
    });
    setAttrs({ ...(batch.attributes ?? {}) });
    setErr(''); setEdit(true);
  };
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.patch(`/api/supplier/batches/${batch.id}`, { ...compact(f), attributes: compact(attrs) });
      setEdit(false); await reload();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  const rows: [string, any][] = [
    ['Grade', batch.grade], ['Kuantitas', `${num(batch.quantity, 2)} ${batch.unit} (tersedia ${num(batch.available_quantity, 2)})`], ['Harga per satuan', `${rupiah(batch.price_per_unit)}/${batch.unit}`],
    ['Perkiraan berat (kg)', batch.expected_weight_kg == null ? null : num(batch.expected_weight_kg, 2)], ['Toleransi berat', batch.weight_tolerance_pct == null ? null : `${num(batch.weight_tolerance_pct, 2)}%`],
    ['Tanggal panen', batch.harvest_date ? d(batch.harvest_date) : null], ['Tanggal tersedia', batch.availability_date ? d(batch.availability_date) : null],
    ['Kondisi', batch.condition], ['Ukuran', batch.size], ['Warna', batch.color], ['Kesegaran', batch.freshness], ['Kelembapan/kadar air', batch.moisture],
    ['Suhu penyimpanan', batch.temperature_c == null ? null : `${num(batch.temperature_c, 1)} °C`], ['Umur simpan', batch.shelf_life_days == null ? null : `${batch.shelf_life_days} hari`],
    ['Tanggal kedaluwarsa', batch.expiry_date ? d(batch.expiry_date) : null],
  ];
  const attrEntries = Object.entries(batch.attributes ?? {});

  return (
    <Card title="Data deklarasi kualitas" actions={editable && !edit && <button className="btn secondary small" onClick={start}>Ubah data</button>}>
      {!editable && <p className="muted"><small>Batch sudah dipublikasikan — data deklarasi terkunci sebagai snapshot yang Anda jamin. Perubahan hanya melalui deklarasi final panen (untuk batch panen).</small></p>}
      {!edit ? (
        <div className="grid cols-2">
          <dl className="kv">
            {rows.map(([k, v]) => <FragmentKV key={k} k={k} v={v} />)}
          </dl>
          <div>
            <h3>Atribut kategori {batch.category_code}</h3>
            {schema.length === 0 && attrEntries.length === 0 ? <Empty>Tidak ada atribut tambahan.</Empty> : (
              <dl className="kv">
                {schema.map((s) => <FragmentKV key={s.key} k={`${s.label}${s.unit ? ` (${s.unit})` : ''}${s.required ? ' *' : ''}`} v={batch.attributes?.[s.key]} />)}
                {attrEntries.filter(([k]) => !schema.some((s) => s.key === k)).map(([k, v]) => <FragmentKV key={k} k={attributeLabel(schema, k)} v={v} />)}
              </dl>
            )}
          </div>
        </div>
      ) : (
        <form className="inline" onSubmit={save}>
          <Field label="Grade" required={batch.type !== 'HARVEST'}><input value={f.grade} onChange={(e) => set('grade', e.target.value)} /></Field>
          <Field label="Kuantitas" required><input type="number" step="any" min={0} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} /></Field>
          <Field label="Satuan"><select value={f.unit} onChange={(e) => set('unit', e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
          <Field label="Harga per satuan (Rp)" required><input type="number" min={1} value={f.price_per_unit} onChange={(e) => set('price_per_unit', e.target.value)} /></Field>
          <Field label="Perkiraan berat (kg)"><input type="number" step="any" value={f.expected_weight_kg} onChange={(e) => set('expected_weight_kg', e.target.value)} /></Field>
          <Field label="Toleransi berat (%)"><input type="number" step="0.1" min={0} max={50} value={f.weight_tolerance_pct} onChange={(e) => set('weight_tolerance_pct', e.target.value)} /></Field>
          <Field label="Tanggal panen"><input type="date" value={f.harvest_date} onChange={(e) => set('harvest_date', e.target.value)} /></Field>
          <Field label="Tanggal tersedia"><input type="date" value={f.availability_date} onChange={(e) => set('availability_date', e.target.value)} /></Field>
          <Field label="Kondisi" required={batch.type !== 'HARVEST'}><input value={f.condition} onChange={(e) => set('condition', e.target.value)} /></Field>
          <Field label="Ukuran"><input value={f.size} onChange={(e) => set('size', e.target.value)} /></Field>
          <Field label="Warna"><input value={f.color} onChange={(e) => set('color', e.target.value)} /></Field>
          <Field label="Kesegaran"><input value={f.freshness} onChange={(e) => set('freshness', e.target.value)} /></Field>
          <Field label="Kelembapan / kadar air"><input value={f.moisture} onChange={(e) => set('moisture', e.target.value)} /></Field>
          <Field label="Suhu penyimpanan (°C)"><input type="number" step="any" value={f.temperature_c} onChange={(e) => set('temperature_c', e.target.value)} /></Field>
          <Field label="Umur simpan (hari)"><input type="number" step="1" value={f.shelf_life_days} onChange={(e) => set('shelf_life_days', e.target.value)} /></Field>
          <Field label="Tanggal kedaluwarsa"><input type="date" value={f.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} /></Field>
          {schema.length > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <h3>Atribut kategori {batch.category_code}</h3>
              <div className="grid cols-3"><AttributeInputs schema={schema} value={attrs} onChange={setAttrs} /></div>
            </div>
          )}
          <div className="form-actions">
            <button className="btn" disabled={busy}>{busy ? '…' : 'Simpan'}</button>
            <button type="button" className="btn secondary" onClick={() => setEdit(false)}>Batal</button>
            {err && <small className="inline-error">{err}</small>}
          </div>
        </form>
      )}
    </Card>
  );
}
function FragmentKV({ k, v }: { k: string; v: any }) {
  return <><dt>{k}</dt><dd>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : String(v)}</dd></>;
}

// ---------- Upload foto ----------
type KindOpt = { kind: string; owner_type: string; label: string };
function PhotoUpload({ batch, options, reload }: { batch: any; options: KindOpt[]; reload: () => Promise<void> }) {
  const [sel, setSel] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [takenAt, setTakenAt] = useState(nowLocal());
  const [withLoc, setWithLoc] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  useEffect(() => { if (sel >= options.length) setSel(0); }, [options.length, sel]);
  const opt = options[Math.min(sel, options.length - 1)];

  const getLocation = () => new Promise<{ lat?: number; lng?: number }>((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { timeout: 8000 },
    );
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setOk('');
    if (!file || !opt) { setErr('Pilih berkas foto terlebih dahulu.'); return; }
    setBusy(true);
    try {
      const loc = withLoc ? await getLocation() : {};
      if (withLoc && loc.lat == null) setOk('Lokasi tidak tersedia/ditolak browser — foto diunggah tanpa lokasi. ');
      await api.upload(file, {
        owner_type: opt.owner_type, kind: opt.kind, batch_id: batch.id,
        taken_at: takenAt ? new Date(takenAt).toISOString() : undefined,
        lat: loc.lat, lng: loc.lng, location_consent: withLoc && loc.lat != null ? true : undefined,
      });
      setOk((s) => s + 'Foto berhasil diunggah.');
      setFile(null); setInputKey((k) => k + 1); setTakenAt(nowLocal());
      await reload();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };

  if (!options.length) return <Empty>Tidak ada jenis foto yang dapat diunggah pada status ini.</Empty>;
  return (
    <form className="inline" onSubmit={submit}>
      <Field label="Jenis foto" required>
        <select value={sel} onChange={(e) => setSel(Number(e.target.value))}>
          {options.map((o, i) => <option key={`${o.owner_type}-${o.kind}`} value={i}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Berkas foto (dari kamera / galeri, foto aktual)" required>
        <input key={inputKey} type="file" accept="image/*" capture="environment" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Waktu pengambilan" hint="Otomatis: sekarang"><input type="datetime-local" value={takenAt} onChange={(e) => setTakenAt(e.target.value)} /></Field>
      <div className="field">
        <span className="field-label">Lokasi</span>
        <label className="row" style={{ gap: 6, paddingTop: 6 }}><input type="checkbox" checked={withLoc} onChange={(e) => setWithLoc(e.target.checked)} /> Sertakan lokasi (opsional, dengan persetujuan)</label>
        <small className="field-hint">Koordinat GPS hanya disimpan jika Anda menyetujui.</small>
      </div>
      <div className="form-actions">
        <button className="btn" disabled={busy}>{busy ? 'Mengunggah…' : 'Unggah foto'}</button>
        {err && <small className="inline-error">{err}</small>}
        {ok && <small style={{ color: 'var(--good)' }}>{ok}</small>}
      </div>
    </form>
  );
}

// ---------- Deklarasi & publish ----------
function PublishBox({ batch, declaration, reload }: { batch: any; declaration: any; reload: () => Promise<void> }) {
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<{ msg: string; details?: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const r = batch.readiness ?? {};
  const publish = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/supplier/batches/${batch.id}/publish`, { accepted: true, declaration_version: declaration.version });
      await reload();
    } catch (x) {
      setErr(x instanceof ApiError ? { msg: x.message, details: x.details } : { msg: errMsg(x) });
    } finally { setBusy(false); }
  };
  return (
    <>
      <p className="muted"><small>Versi {declaration?.version} — {declaration?.title}</small></p>
      <div className="declaration-box">{declaration?.body}</div>
      <label className="row" style={{ gap: 8, marginBottom: 10 }}>
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>Saya menyatakan dan menyetujui <b>Quality Self Declaration &amp; Return Guarantee</b> di atas untuk batch <b>{batch.batch_code}</b>. Persetujuan dicatat beserta waktu, alamat IP, dan snapshot data deklarasi.</span>
      </label>
      {err && (
        <Alert kind="error">
          <b>{err.msg === 'DECLARATION_INCOMPLETE' ? 'Deklarasi belum lengkap' : err.msg === 'SUPPLIER_LISTING_RESTRICTED' ? 'Publikasi dibatasi oleh status akun' : err.msg}</b>
          {err.details?.missing_fields?.length > 0 && <div>Field wajib belum diisi: {err.details.missing_fields.map((m: string) => FIELD_LABEL[m] ?? (m.startsWith('attributes.') ? attributeLabel(batch.attribute_schema, m.slice(11)) : m)).join(', ')}</div>}
          {err.details?.missing_photo_kinds?.length > 0 && <div>Jenis foto belum ada: {err.details.missing_photo_kinds.map((k: string) => PHOTO_KIND_LABEL[k] ?? k).join(', ')}</div>}
          {err.details?.photos != null && <div>Foto terunggah {err.details.photos} dari minimum {err.details.min_photos}.</div>}
          {err.details?.status && <div>Status akun: {err.details.status}</div>}
          {!err.details?.missing_fields && !err.details?.status && err.details && <div><small>{JSON.stringify(err.details)}</small></div>}
        </Alert>
      )}
      <div className="row">
        <button className="btn" disabled={!agree || busy || !declaration} onClick={publish}>{busy ? '…' : batch.type === 'HARVEST' ? 'Publikasikan sebagai "Akan panen"' : 'Publikasikan — siap dipesan'}</button>
        {!r.ok && <small className="muted">Checklist kesiapan belum lengkap; server akan menolak publikasi sampai semua terpenuhi.</small>}
      </div>
    </>
  );
}

// ---------- Harvest: pre-update ----------
function PreHarvestForm({ batch, reload }: { batch: any; reload: () => Promise<void> }) {
  const h = batch.harvest ?? {};
  const [f, setF] = useState<any>({ current_condition: h.current_condition ?? '', forecast_confidence: h.forecast_confidence ?? '', expected_quantity: h.expected_quantity ?? '', expected_harvest_date: toDateInput(h.expected_harvest_date), note: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const prePhotos = (batch.photos ?? []).filter((p: any) => p.owner_type === 'HARVEST_PRE').length;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post(`/api/supplier/batches/${batch.id}/harvest/pre-update`, compact(f)); await reload(); }
    catch (x) { setErr(errMsg(x) === 'PRE_HARVEST_PHOTO_REQUIRED' ? 'Unggah minimal 1 foto jenis "Pre-harvest" terlebih dahulu.' : errMsg(x)); }
    finally { setBusy(false); }
  };
  return (
    <form className="inline" onSubmit={submit}>
      <div style={{ gridColumn: '1 / -1' }}>
        {prePhotos < 1
          ? <Alert kind="warn">Wajib mengunggah minimal <b>1 foto Pre-harvest</b> (kondisi tanaman/lahan menjelang panen) di bagian foto sebelum mengirim update ini. Saat ini: 0 foto.</Alert>
          : <Alert kind="success">{prePhotos} foto pre-harvest sudah terunggah.</Alert>}
      </div>
      <Field label="Kondisi terkini" required><input required value={f.current_condition} onChange={(e) => set('current_condition', e.target.value)} placeholder="cth. Bulir mulai menguning 80%, tidak ada serangan hama" /></Field>
      <Field label="Keyakinan forecast (0–100)"><input type="number" min={0} max={100} value={f.forecast_confidence} onChange={(e) => set('forecast_confidence', e.target.value)} /></Field>
      <Field label={`Estimasi kuantitas (${batch.unit})`}><input type="number" step="any" min={0} value={f.expected_quantity} onChange={(e) => set('expected_quantity', e.target.value)} /></Field>
      <Field label="Perkiraan tanggal panen"><input type="date" value={f.expected_harvest_date} onChange={(e) => set('expected_harvest_date', e.target.value)} /></Field>
      <Field label="Catatan"><input value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn" disabled={busy}>{busy ? '…' : 'Kirim PRE-HARVEST QUALITY UPDATE'}</button>
        {err && <small className="inline-error">{err}</small>}
      </div>
    </form>
  );
}

// ---------- Harvest: finalize ----------
function FinalizeForm({ batch, declaration, minPhotos, reload }: { batch: any; declaration: any; minPhotos: number; reload: () => Promise<void> }) {
  const h = batch.harvest ?? {};
  const schema: AttrField[] = batch.attribute_schema ?? [];
  const [f, setF] = useState<any>({ actual_quantity: h.expected_quantity ?? '', actual_grade: h.expected_grade ?? batch.grade ?? '', actual_weight_kg: '', actual_condition: '', actual_harvest_date: toDateInput(new Date()), price_per_unit: batch.price_per_unit ?? '' });
  const [attrs, setAttrs] = useState<Record<string, any>>({ ...(batch.attributes ?? {}) });
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const finalPhotos = (batch.photos ?? []).filter((p: any) => p.owner_type === 'HARVEST_FINAL').length;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post(`/api/supplier/batches/${batch.id}/harvest/finalize`, { ...compact(f), attributes: compact(attrs), accepted: true, declaration_version: declaration.version });
      await reload();
    } catch (x) {
      if (x instanceof ApiError && x.message === 'FINAL_PHOTOS_REQUIRED') setErr(`Wajib ${x.details?.required} foto hasil panen final; terunggah ${x.details?.uploaded}.`);
      else setErr(errMsg(x));
    } finally { setBusy(false); }
  };
  return (
    <form className="inline" onSubmit={submit}>
      <div style={{ gridColumn: '1 / -1' }}>
        {finalPhotos < minPhotos
          ? <Alert kind="warn">Wajib mengunggah minimal <b>{minPhotos} foto "Hasil panen final"</b> (barang aktual hasil panen) sebelum deklarasi final. Saat ini: {finalPhotos} foto.</Alert>
          : <Alert kind="success">{finalPhotos} foto hasil panen final sudah terunggah (minimum {minPhotos}).</Alert>}
      </div>
      <Field label={`Kuantitas aktual (${batch.unit})`} required hint={`Estimasi awal: ${num(h.expected_quantity, 2)}`}><input type="number" step="any" min={0} required value={f.actual_quantity} onChange={(e) => set('actual_quantity', e.target.value)} /></Field>
      <Field label="Grade aktual" required hint={h.expected_grade ? `Perkiraan: ${h.expected_grade}` : undefined}><input required value={f.actual_grade} onChange={(e) => set('actual_grade', e.target.value)} /></Field>
      <Field label="Berat aktual (kg)"><input type="number" step="any" min={0} value={f.actual_weight_kg} onChange={(e) => set('actual_weight_kg', e.target.value)} /></Field>
      <Field label="Kondisi aktual" required><input required value={f.actual_condition} onChange={(e) => set('actual_condition', e.target.value)} placeholder="cth. Kering, bersih, seragam" /></Field>
      <Field label="Tanggal panen aktual" required><input type="date" required value={f.actual_harvest_date} onChange={(e) => set('actual_harvest_date', e.target.value)} /></Field>
      <Field label="Harga per satuan (Rp)" hint="Kosongkan untuk mempertahankan harga saat ini"><input type="number" min={1} value={f.price_per_unit} onChange={(e) => set('price_per_unit', e.target.value)} /></Field>
      {schema.length > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <h3>Atribut kualitas aktual — kategori {batch.category_code}</h3>
          <div className="grid cols-3"><AttributeInputs schema={schema} value={attrs} onChange={setAttrs} /></div>
        </div>
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <h3>Quality Self Declaration &amp; Return Guarantee (deklarasi final)</h3>
        <p className="muted"><small>Versi {declaration?.version} — {declaration?.title}</small></p>
        <div className="declaration-box">{declaration?.body}</div>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>Saya menyatakan dan menyetujui deklarasi di atas untuk hasil panen aktual batch <b>{batch.batch_code}</b>.</span>
        </label>
      </div>
      <div className="form-actions">
        <button className="btn" disabled={busy || !agree || !declaration}>{busy ? '…' : 'Kirim FINAL HARVEST DECLARATION → Siap dipesan'}</button>
        {err && <small className="inline-error">{err}</small>}
      </div>
    </form>
  );
}

// ---------- Page ----------
export default function BatchDetail() {
  const { id } = useParams();
  const batchQ = useAsync<any>(() => api.get(`/api/supplier/batches/${id}`), [id]);
  const declQ = useAsync<any>(() => api.get('/api/declaration'));
  const reload = async () => { await batchQ.reload(); };
  const batch = batchQ.data;

  const photoOptions = useMemo<KindOpt[]>(() => {
    if (!batch) return [];
    const st: string = batch.status;
    if (batch.type === 'READY_STOCK') {
      if (st !== 'DRAFT') return [{ kind: 'OTHER', owner_type: 'BATCH', label: 'Foto tambahan (lainnya)' }];
      return [
        { kind: 'OVERALL', owner_type: 'BATCH', label: 'Keseluruhan barang' },
        { kind: 'CLOSEUP', owner_type: 'BATCH', label: 'Close-up kualitas' },
        { kind: 'PACKAGING', owner_type: 'BATCH', label: 'Kondisi packaging/penyimpanan' },
      ];
    }
    if (st === 'DRAFT') return [{ kind: 'CURRENT', owner_type: 'HARVEST_CURRENT', label: 'Kondisi saat ini (tanaman/lahan)' }];
    if (['UPCOMING', 'PRE_HARVEST_UPDATED'].includes(st)) return [
      { kind: 'PRE_HARVEST', owner_type: 'HARVEST_PRE', label: 'Pre-harvest — kondisi menjelang panen' },
      { kind: 'FINAL', owner_type: 'HARVEST_FINAL', label: 'Hasil panen final (barang aktual)' },
      { kind: 'CURRENT', owner_type: 'HARVEST_CURRENT', label: 'Kondisi saat ini (tambahan)' },
    ];
    return [{ kind: 'OTHER', owner_type: 'BATCH', label: 'Foto tambahan (lainnya)' }];
  }, [batch?.status, batch?.type, batch?.id]);

  if (batchQ.loading && !batch) return <p>Memuat…</p>;
  if (batchQ.error) return <Alert kind="error">{batchQ.error}</Alert>;
  if (!batch) return <Empty />;

  const r = batch.readiness ?? {};
  const isHarvest = batch.type === 'HARVEST';
  const isDraft = batch.status === 'DRAFT';
  const inUpcoming = isHarvest && ['UPCOMING', 'PRE_HARVEST_UPDATED'].includes(batch.status);
  const photos: any[] = batch.photos ?? [];
  const groups = ['BATCH', 'HARVEST_CURRENT', 'HARVEST_PRE', 'HARVEST_FINAL'].filter((g) => photos.some((p) => p.owner_type === g));
  const finalMin = Number(batch.readiness?.final_min_photos ?? batch.min_photos ?? 3);
  const h = batch.harvest;
  const acceptance = batch.acceptance;

  return (
    <>
      <div className="page-head">
        <div>
          <small><Link to="/supplier/products">← Produk &amp; Batch</Link></small>
          <h1>{batch.product_name} <code>{batch.batch_code}</code></h1>
          <p>{BATCH_TYPE_LABEL[batch.type] ?? batch.type} · kategori {batch.category_code} · dibuat {dt(batch.created_at)}{batch.published_at ? ` · dipublikasikan ${dt(batch.published_at)}` : ''}</p>
        </div>
        <div className="row">
          <Badge tone={statusTone(batch.status)}>{BATCH_STATUS_LABEL[batch.status] ?? batch.status}</Badge>
          {isHarvest && h?.stage && <Badge>{HARVEST_STAGE_LABEL[h.stage] ?? h.stage}</Badge>}
        </div>
      </div>
      <Steps batch={batch} />

      <p className="muted" style={{ marginBottom: 12 }}><small><b>DECLARE → PROVE:</b> Anda mendeklarasikan kualitas, lalu membuktikannya dengan foto barang aktual, dan menjamin retur bila tidak sesuai. Deklarasi ini menjadi dasar pembanding saat inspeksi buyer dan penilaian klaim retur.</small></p>

      <DeclarationData batch={batch} reload={reload} />

      <div className="grid cols-2">
        <Card title="Bukti foto (wajib, dari barang aktual — bukan stock image)">
          <p className="muted"><small>
            Terunggah <b>{r.photos ?? photos.length}</b> foto deklarasi dari minimum <b>{r.min_photos}</b>.
            {(r.missing_photo_kinds ?? []).length > 0 && <> Jenis yang masih kurang: <b>{r.missing_photo_kinds.map((k: string) => PHOTO_KIND_LABEL[k] ?? k).join(', ')}</b>.</>}
            {' '}Foto harus diambil langsung dari batch yang dijual; stock image / foto dari internet ditolak dan dapat berdampak pada Quality Score.
          </small></p>
          <PhotoUpload batch={batch} options={photoOptions} reload={reload} />
        </Card>

        <Card title="Checklist kesiapan">
          <ul className="checklist">
            {(r.missing_fields ?? []).map((m: string) => (
              <li key={m} className="no">{FIELD_LABEL[m] ?? (m.startsWith('attributes.') ? `Atribut: ${attributeLabel(batch.attribute_schema, m.slice(11))}` : m)} belum diisi</li>
            ))}
            {(r.missing_fields ?? []).length === 0 && <li className="ok">Semua field wajib data barang terisi</li>}
            {(r.missing_photo_kinds ?? []).map((k: string) => <li key={k} className="no">Foto {PHOTO_KIND_LABEL[k] ?? k} belum ada</li>)}
            <li className={Number(r.photos) >= Number(r.min_photos) ? 'ok' : 'no'}>Jumlah foto {r.photos}/{r.min_photos}</li>
            <li className={isDraft ? (acceptance ? 'ok' : 'no') : 'ok'}>Deklarasi kualitas &amp; jaminan retur {isDraft && !acceptance ? 'belum disetujui' : 'disetujui'}</li>
            {isHarvest && !isDraft && (
              <>
                <li className={h?.stage === 'PRE_HARVEST_UPDATED' || h?.stage === 'FINAL' ? 'ok' : 'no'}>Pre-harvest quality update {h?.pre_harvest_updated_at ? `(${dt(h.pre_harvest_updated_at)})` : '— belum'}</li>
                <li className={h?.stage === 'FINAL' ? 'ok' : 'no'}>Deklarasi final panen {h?.finalized_at ? `(${dt(h.finalized_at)})` : '— belum'}</li>
              </>
            )}
          </ul>
          {r.ok && isDraft && <Alert kind="success">Data dan foto lengkap — lanjutkan ke deklarasi &amp; publikasi.</Alert>}
        </Card>
      </div>

      <Card title="Galeri bukti">
        {photos.length === 0 ? <Empty>Belum ada foto. Unggah foto bukti di atas.</Empty> : groups.map((g) => (
          <div key={g} style={{ marginBottom: 12 }}>
            <h3>{OWNER_TYPE_LABEL[g] ?? g} <small>({photos.filter((p) => p.owner_type === g).length})</small></h3>
            <EvidenceGallery files={photos.filter((p) => p.owner_type === g)} />
          </div>
        ))}
      </Card>

      <Card title="QUALITY SELF DECLARATION & RETURN GUARANTEE">
        {declQ.error && <Alert kind="error">Gagal memuat teks deklarasi: {declQ.error}</Alert>}
        {acceptance && (
          <Alert kind="success">
            <b>Deklarasi disetujui</b> — versi {acceptance.declaration_version}, pada {dt(acceptance.accepted_at)}, dari IP <code>{acceptance.ip_address ?? '-'}</code>.
            {batch.declaration_accepted_at && <> Terakhir diperbarui {dt(batch.declaration_accepted_at)}.</>}
          </Alert>
        )}
        {isDraft ? (
          declQ.data ? <PublishBox batch={batch} declaration={declQ.data} reload={reload} /> : <p>Memuat deklarasi…</p>
        ) : (
          <>
            <div className="declaration-box">{declQ.data?.body}</div>
            <p className="muted"><small>Batch sudah dipublikasikan dengan status <b>{BATCH_STATUS_LABEL[batch.status] ?? batch.status}</b>. Jaminan retur berlaku untuk seluruh pesanan dari batch ini.</small></p>
          </>
        )}
      </Card>

      {isHarvest && (
        <Card title="Siklus panen (pre-order)">
          {!h ? <Empty>Data panen tidak ditemukan.</Empty> : (
            <div className="compare" style={{ marginBottom: 14 }}>
              <div className="col">
                <h4>Perkiraan (saat publikasi)</h4>
                <dl className="kv">
                  <FragmentKV k="Tanggal tanam" v={h.planting_date ? d(h.planting_date) : null} />
                  <FragmentKV k="Perkiraan panen" v={d(h.expected_harvest_date)} />
                  <FragmentKV k="Estimasi kuantitas" v={`${num(h.expected_quantity, 2)} ${batch.unit}`} />
                  <FragmentKV k="Perkiraan grade" v={h.expected_grade} />
                  <FragmentKV k="Perkiraan kualitas" v={h.expected_quality} />
                  <FragmentKV k="Keyakinan forecast" v={h.forecast_confidence == null ? null : `${h.forecast_confidence}%`} />
                </dl>
              </div>
              <div className="arrow">→</div>
              <div className="col">
                <h4>Pre-harvest update</h4>
                <dl className="kv">
                  <FragmentKV k="Kondisi terkini" v={h.current_condition} />
                  <FragmentKV k="Catatan" v={h.pre_harvest_note} />
                  <FragmentKV k="Diperbarui" v={h.pre_harvest_updated_at ? dt(h.pre_harvest_updated_at) : null} />
                </dl>
              </div>
              <div className="arrow">→</div>
              <div className="col">
                <h4>Aktual (deklarasi final)</h4>
                <dl className="kv">
                  <FragmentKV k="Tanggal panen" v={h.actual_harvest_date ? d(h.actual_harvest_date) : null} />
                  <FragmentKV k="Kuantitas aktual" v={h.actual_quantity == null ? null : `${num(h.actual_quantity, 2)} ${batch.unit}`} />
                  <FragmentKV k="Grade aktual" v={h.actual_grade} />
                  <FragmentKV k="Berat aktual" v={h.actual_weight_kg == null ? null : `${num(h.actual_weight_kg, 2)} kg`} />
                  <FragmentKV k="Kondisi aktual" v={h.actual_condition} />
                  <FragmentKV k="Difinalisasi" v={h.finalized_at ? dt(h.finalized_at) : null} />
                  {h.actual_quantity != null && h.expected_quantity > 0 && (
                    <FragmentKV k="Akurasi deklarasi" v={`${num(Math.max(0, 1 - Math.abs(h.actual_quantity - h.expected_quantity) / h.expected_quantity) * 100, 1)}%`} />
                  )}
                </dl>
              </div>
            </div>
          )}
          {isDraft && <Alert kind="info">Publikasikan batch terlebih dahulu (status "Akan panen") untuk membuka PRE-HARVEST QUALITY UPDATE dan FINAL HARVEST DECLARATION.</Alert>}
          {inUpcoming && (
            <div className="grid cols-2">
              <Card title="PRE-HARVEST QUALITY UPDATE"><PreHarvestForm batch={batch} reload={reload} /></Card>
              <Card title="FINAL HARVEST DECLARATION">
                {declQ.data ? <FinalizeForm batch={batch} declaration={declQ.data} minPhotos={finalMin} reload={reload} /> : <p>Memuat deklarasi…</p>}
              </Card>
            </div>
          )}
          {isHarvest && batch.status === 'READY_FOR_ORDER' && <Alert kind="success">Panen telah difinalisasi — batch siap dipesan dengan data aktual di atas.</Alert>}
        </Card>
      )}

      <p className="footer-note">Semua foto menyertakan waktu pengambilan dan waktu unggah; lokasi hanya disimpan atas persetujuan. Snapshot data deklarasi disimpan saat publikasi dan dipakai sebagai pembanding pada inspeksi buyer &amp; evaluasi retur.</p>
    </>
  );
}
