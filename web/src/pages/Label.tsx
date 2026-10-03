import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { api, errMsg, num, d as fmtDate, dt } from '../lib/api';
import { Alert } from '../components/ui';

/**
 * LABEL PAKET — printable (browser → PDF/printer). Template A4 (100×70 mm per label) dan THERMAL80 (72 mm).
 * QR = "SID:PKG:<package_no>" (ID internal, bukan GTIN/GS1) → menunjuk record server; Code 128 = package_no.
 * Setiap klik "Cetak" tercatat (label_prints); cetak ulang wajib alasan & menaikkan versi.
 */
export default function Label() {
  const { id } = useParams(); const [sp] = useSearchParams();
  const template = (sp.get('t') === 'thermal' ? 'THERMAL80' : 'A4') as 'A4' | 'THERMAL80';
  const [p, setP] = useState<any>(null); const [err, setErr] = useState(''); const [qr, setQr] = useState('');
  const [reason, setReason] = useState(''); const [printed, setPrinted] = useState<any>(null);
  const bc = useRef<SVGSVGElement>(null);
  const load = async () => { try { const r = await api.get(`/api/packages/${id}/label`); setP(r); setQr(await QRCode.toDataURL(r.qr_payload, { margin: 0, width: 220, errorCorrectionLevel: 'M' })); } catch (e) { setErr(errMsg(e)); } };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { if (p && bc.current) JsBarcode(bc.current, p.code128, { format: 'CODE128', displayValue: true, height: 40, width: 1.4, fontSize: 11, margin: 0 }); }, [p]);
  const print = async () => {
    setErr('');
    try { const r = await api.post(`/api/packages/${id}/print`, { template, reason: reason || undefined }); setPrinted(r); setTimeout(() => window.print(), 300); await load(); }
    catch (e) { setErr(errMsg(e)); }
  };
  if (err && !p) return <div className="main"><Alert kind="error">{err}</Alert></div>;
  if (!p) return <div className="main"><p className="muted">Memuat label…</p></div>;
  const reprint = (p.prints ?? []).length > 0;
  const body = (
    <>
      <div>
        <div className="title">Supplier-ID · {p.category_name}</div>
        <div className="big">{p.package_no}</div>
        <div className="kv">
          <span>Produk</span><b>{p.product_name}{p.grade ? ` · Grade ${p.grade}` : ''}</b>
          <span>Isi</span><b>{num(p.quantity, 2)} {p.unit}{p.weight_kg ? ` · ${num(p.weight_kg, 2)} kg` : ''}</b>
          <span>Pesanan</span><span>{p.order_no}{p.group_no ? ` (${p.group_no})` : ''}</span>
          <span>Batch / lot</span><span>{p.batch_code}{p.lot_code ? ` / ${p.lot_code}` : ''}</span>
          <span>Mitra asal</span><span>{p.supplier_name}{p.supplier_region ? `, ${p.supplier_region}` : ''}</span>
          <span>Panen / packing</span><span>{fmtDate(p.harvest_date)} / {dt(p.packed_at)}</span>
          {p.expiry_date && <><span>Baik sebelum</span><b>{fmtDate(p.expiry_date)}</b></>}
          {p.storage_instructions && <><span>Simpan</span><span>{p.storage_instructions}</span></>}
          <span>Penerima</span><span>{p.buyer_name}<br />{p.delivery_address}</span>
        </div>
        <div style={{ fontSize: '7pt', marginTop: '2mm' }}>Label v{p.label_version} · ID internal Supplier-ID (bukan GS1) · scan untuk info aman: supplier-id/p/{p.package_no}</div>
      </div>
      <div style={{ display: 'grid', gap: '2mm', alignContent: 'start' }}>
        {qr && <img src={qr} alt={`QR ${p.package_no}`} style={{ width: '32mm', height: '32mm' }} />}
        <svg ref={bc} style={{ width: '34mm' }} aria-label={`Barcode ${p.package_no}`} />
      </div>
    </>
  );
  return (
    <div className="label-sheet" style={{ padding: 16 }}>
      <div className="no-print card">
        <div className="row between">
          <div><b>Cetak label {p.package_no}</b> · template <b>{template}</b> · <Link to={`/labels/${id}?t=${template === 'A4' ? 'thermal' : 'a4'}`}>ganti ke {template === 'A4' ? 'thermal 80 mm' : 'A4'}</Link><br /><small className="muted">Sudah dicetak {(p.prints ?? []).length}× · versi saat ini v{p.label_version}. {reprint ? 'Cetak ulang wajib alasan; versi lama dianggap tidak berlaku.' : ''}</small></div>
          <div className="row">{reprint && <input placeholder="Alasan cetak ulang" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 220 }} />}<button className="btn" onClick={print} disabled={reprint && reason.length < 3}>Cetak{reprint ? ' ulang' : ''}</button></div>
        </div>
        {err && <Alert kind="error">{err}</Alert>}
        {printed && <Alert kind="success">Tercatat: versi {printed.version}{printed.reprint ? ' (cetak ulang)' : ''}. Dialog cetak dibuka — pilih "Simpan sebagai PDF" bila perlu.</Alert>}
      </div>
      {template === 'A4' ? <div className="label-a4">{body}</div> : <div className="label-thermal">{body}</div>}
    </div>
  );
}
