import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dt, errMsg, num, PKG_STATUS_LABEL } from '../../lib/api';
import { Alert, AsyncButton, Badge, Card, Empty, Field, Timeline, useAsync } from '../../components/ui';

const S_LABEL: Record<string, string> = { SCHEDULED: 'Jemput', PICKED_UP: 'Diambil', IN_TRANSIT: 'Antar', ARRIVED: 'Tiba', DELIVERED: 'Terkirim', RECEIVED: 'Diterima', DELIVERY_FAILED: 'Gagal antar', RETURNED: 'Dikembalikan' };

/** MANIFEST KURIR — mobile-first. */
export default function Manifest() {
  const m = useAsync<any[]>(() => api.get('/api/courier/shipments'), []);
  const groups: Record<string, any[]> = { SCHEDULED: [], PICKED_UP: [], IN_TRANSIT: [], DELIVERY_FAILED: [], DONE: [] };
  for (const s of m.data ?? []) (groups[['SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERY_FAILED'].includes(s.status) ? s.status : 'DONE'] ??= []).push(s);
  return (
    <>
      <div className="page-head"><div><h1>Manifest hari ini</h1><p>Pindai setiap paket saat pickup dan serah terima. Status disahkan server.</p></div><button className="btn secondary small" onClick={m.reload}>Muat ulang</button></div>
      {m.loading && !m.data && <div className="skeleton" style={{ minHeight: 120 }} />}
      {m.error && <Alert kind="error">{m.error}</Alert>}
      {m.data && !m.data.length && <Empty>Belum ada penugasan.</Empty>}
      {(['SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERY_FAILED', 'DONE'] as const).map((k) => groups[k]?.length ? (
        <Card key={k} title={`${k === 'DONE' ? 'Selesai' : S_LABEL[k]} (${groups[k].length})`}>
          {groups[k].map((s: any) => (
            <Link key={s.id} to={`/courier/shipments/${s.id}`} className="task-card">
              <div className="stage">{(s.packages ?? []).length}📦</div>
              <div><b>{s.order_no}</b> · {s.product_name} · {num(s.quantity)} {s.unit}<br /><small className="muted">{k === 'SCHEDULED' ? `Jemput: ${s.supplier_name} — ${s.supplier_address ?? ''}` : `Antar: ${s.buyer_name} — ${s.delivery_address ?? ''}`}</small></div>
              <Badge tone={s.status === 'DELIVERY_FAILED' ? 'bad' : undefined}>{S_LABEL[s.status]}</Badge>
            </Link>
          ))}
        </Card>
      ) : null)}
    </>
  );
}

/** Pemindai kamera (BarcodeDetector bila tersedia) + input manual. */
export function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null); const [on, setOn] = useState(false); const [sup, setSup] = useState<boolean | null>(null); const [manual, setManual] = useState('');
  useEffect(() => { setSup('BarcodeDetector' in window); }, []);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null; let raf = 0; let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const det = new (window as any).BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        const loop = async () => { if (stop) return; try { const codes = await det.detect(video.current!); if (codes.length) { const raw = String(codes[0].rawValue); onCode(raw.startsWith('SID:PKG:') ? raw.slice(8) : raw); setOn(false); return; } } catch { /* frame gagal */ } raf = requestAnimationFrame(loop); };
        loop();
      } catch { setSup(false); setOn(false); }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [on]);
  return (
    <div className="scan-box">
      {sup && (on ? <video ref={video} className="scanner" muted playsInline /> : <button className="btn secondary" onClick={() => setOn(true)}>📷 Pindai dengan kamera</button>)}
      {sup === false && <small className="muted">Kamera/BarcodeDetector tidak tersedia di browser ini — ketik ID paket manual.</small>}
      <div className="row"><input aria-label="ID paket" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="PKG-2026-000001" onKeyDown={(e) => { if (e.key === 'Enter' && manual.length > 4) { onCode(manual); setManual(''); } }} /><button className="btn" disabled={manual.length < 5} onClick={() => { onCode(manual); setManual(''); }}>OK</button></div>
    </div>
  );
}

export function ShipmentDetail() {
  const { id } = useParams();
  const s = useAsync<any>(() => api.get(`/api/courier/shipments/${id}`), [id]);
  const [log, setLog] = useState<any[]>([]); const [err, setErr] = useState('');
  const [otp, setOtp] = useState(''); const [recipient, setRecipient] = useState(''); const [fail, setFail] = useState(''); const [ev, setEv] = useState({ location: '', temperature_c: '' });
  const [file, setFile] = useState<File | null>(null); const [up, setUp] = useState('');
  const d = s.data;
  const act = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await s.reload(); } catch (e) { setErr(errMsg(e)); throw e; } };
  const scan = async (code: string, action: 'PICKUP' | 'DELIVER') => {
    const r = await api.post('/api/scan', { code, action, shipment_id: id }).catch((e) => ({ code, result: 'REJECTED', reason: e?.message ?? errMsg(e), ...(e?.details ?? {}) }));
    setLog([r, ...log]); await s.reload();
  };
  if (s.loading && !d) return <p className="muted">Memuat…</p>;
  if (s.error) return <Alert kind="error">{s.error}</Alert>;
  if (!d) return null;
  const pkgs = d.packages ?? [];
  const action = d.status === 'SCHEDULED' ? 'PICKUP' : 'DELIVER';
  const allScanned = pkgs.length > 0 && pkgs.every((p: any) => p.status === (action === 'PICKUP' ? 'PICKED_UP' : 'DELIVERED'));
  return (
    <>
      <div className="page-head"><div><small className="muted"><Link to="/courier">Manifest</Link> / {d.tracking_no}</small><h1>{d.order_no} <Badge tone={d.status === 'DELIVERY_FAILED' ? 'bad' : undefined}>{S_LABEL[d.status]}</Badge></h1>
        <p><b>{d.product_name}</b> · {num(d.quantity)} {d.unit} · {pkgs.length} paket{d.cold_chain ? ' · ❄ cold chain' : ''}<br /><small className="muted">Jemput: {d.supplier_name} — {d.supplier_address ?? '-'}<br />Antar: {d.buyer_name} — {d.delivery_address ?? '-'}</small></p></div></div>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="grid cols-2">
        <div>
          {['SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERY_FAILED'].includes(d.status) && (
            <Card title={action === 'PICKUP' ? 'Pindai paket saat pickup' : 'Pindai paket saat serah terima'}>
              <Scanner onCode={(c) => scan(c, action)} />
              <ul className="scan-log">{log.map((l, i) => <li key={i}><span className={`scan-result ${l.result === 'OK' ? 'ok' : 'rej'}`} style={{ padding: '2px 8px' }}>{l.result}</span> {l.code}{l.reason ? ` — ${l.reason}` : ''}</li>)}</ul>
              <div style={{ marginTop: 8 }}>{pkgs.map((p: any) => <div key={p.id} className="row between"><code>{p.package_no}</code><Badge tone={p.status === (action === 'PICKUP' ? 'PICKED_UP' : 'DELIVERED') ? 'good' : undefined}>{PKG_STATUS_LABEL[p.status]}</Badge></div>)}</div>
            </Card>
          )}
          {d.status === 'SCHEDULED' && <Card title="Konfirmasi pickup"><AsyncButton className="btn lg block" disabled={!allScanned} onClick={() => act(() => api.post(`/api/courier/shipments/${id}/pickup`))}>Semua paket diambil ({pkgs.filter((p: any) => p.status === 'PICKED_UP').length}/{pkgs.length})</AsyncButton></Card>}
          {['PICKED_UP', 'IN_TRANSIT', 'DELIVERY_FAILED'].includes(d.status) && (
            <>
              <Card title="Serah terima ke penerima">
                <p className="muted"><small>Minta <b>OTP</b> dari aplikasi pelanggan (bukti sah, jendela konfirmasi langsung dimulai). Bila penerima tidak punya OTP, unggah foto bukti — akan diverifikasi operasional.</small></p>
                <Field label="Nama penerima" required><input value={recipient} onChange={(e) => setRecipient(e.target.value)} /></Field>
                <Field label="OTP penerima (6 digit)"><input inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 22, letterSpacing: '.3em' }} /></Field>
                <Field label="Foto bukti (tanpa OTP)"><div className="row"><input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><button className="btn small secondary" disabled={!file} onClick={async () => { setUp('…'); try { await api.upload(file!, { owner_type: 'DELIVERY', kind: 'DELIVERY_PROOF', shipment_id: id, taken_at: new Date().toISOString() }); setUp('Foto terunggah ✓'); } catch (e) { setUp(errMsg(e)); } }}>Unggah</button>{up && <small>{up}</small>}</div></Field>
                <AsyncButton className="btn lg block" disabled={!allScanned || recipient.length < 2 || (otp.length > 0 && otp.length < 6)} onClick={() => act(() => api.post(`/api/courier/shipments/${id}/deliver`, { otp: otp || undefined, recipient_name: recipient }))}>Selesaikan serah terima</AsyncButton>
                {!allScanned && <small className="muted">Pindai semua paket (DELIVER) terlebih dahulu.</small>}
              </Card>
              <Card title="Tracking / gagal antar">
                <div className="grid cols-2"><Field label="Lokasi"><input value={ev.location} onChange={(e) => setEv({ ...ev, location: e.target.value })} /></Field><Field label="Suhu (°C)"><input type="number" inputMode="decimal" value={ev.temperature_c} onChange={(e) => setEv({ ...ev, temperature_c: e.target.value })} /></Field></div>
                <div className="row"><AsyncButton className="btn secondary" onClick={() => act(() => api.post(`/api/courier/shipments/${id}/events`, { location: ev.location || undefined, temperature_c: ev.temperature_c ? Number(ev.temperature_c) : undefined }))}>Tambah checkpoint</AsyncButton>
                  {d.status !== 'DELIVERY_FAILED' && <><input placeholder="alasan gagal antar" value={fail} onChange={(e) => setFail(e.target.value)} style={{ width: 200 }} /><AsyncButton className="btn danger" disabled={fail.length < 3} onClick={() => act(() => api.post(`/api/courier/shipments/${id}/fail`, { reason: fail }))}>Gagal antar</AsyncButton></>}
                  {d.status === 'DELIVERY_FAILED' && <AsyncButton onClick={() => act(() => api.post(`/api/courier/shipments/${id}/redeliver`))}>Kirim ulang</AsyncButton>}</div>
              </Card>
            </>
          )}
          {['ARRIVED', 'DELIVERED', 'RECEIVED'].includes(d.status) && <Alert kind="success">Serah terima selesai {dt(d.delivered_at)} ke {d.recipient_name} ({d.delivery_evidence?.method}{d.delivery_evidence?.verified ? ', terverifikasi' : ', menunggu verifikasi ops'}).</Alert>}
        </div>
        <Card title="Riwayat"><Timeline items={(d.events ?? []).map((e: any) => ({ at: e.occurred_at, title: e.event_type, note: [e.location, e.temperature_c != null ? `${e.temperature_c}°C` : null, e.note].filter(Boolean).join(' · ') }))} /></Card>
      </div>
    </>
  );
}
