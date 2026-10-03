/**
 * KURIR / DISPATCHER: manifest, penugasan, pickup (scan), tracking, serah terima dengan OTP penerima atau foto bukti,
 * gagal antar, kirim ulang. Bukti penerimaan sah (OTP) memulai jendela konfirmasi 24 jam; foto kurir butuh verifikasi ops.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, maybe, tx } from '../db';
import { asyncH, parse, bad, conflict, forbidden, requireRole, requirePerm } from '../lib/http';
import { getSetting } from '../services/config';
import { transition } from '../services/orders';
import { generateOtp, hashOtp } from '../services/fulfillment';
import { startConfirmationWindow } from '../services/settlement';
import { notify } from '../services/notify';
import { postLogisticsCost } from '../services/ledger';

export const courierRouter = Router();

const SHIP_SELECT = `SELECT s.*, o.order_no, o.status AS order_status, o.delivery_address, o.quantity, o.unit, o.buyer_id, o.supplier_id, p.name AS product_name, so.name AS supplier_name, so.address AS supplier_address, bo.name AS buyer_name,
    cu.name AS courier_name,
    (SELECT json_agg(json_build_object('id',pk.id,'package_no',pk.package_no,'status',pk.status,'quantity',pk.quantity,'unit',pk.unit,'weight_kg',pk.weight_kg) ORDER BY pk.package_no) FROM packages pk WHERE pk.order_id=o.id AND pk.status<>'CANCELLED') AS packages
  FROM shipments s JOIN orders o ON o.id=s.order_id JOIN products p ON p.id=o.product_id JOIN organizations so ON so.id=o.supplier_id JOIN organizations bo ON bo.id=o.buyer_id LEFT JOIN users cu ON cu.id=s.courier_user_id`;

/** Dispatcher: daftar order siap pickup & shipment aktif; penugasan kurir. */
courierRouter.get('/dispatch/ready', requirePerm('shipments.manage', 'orders.read'), asyncH(async (_req, res) => {
  const ready = await q(pool, `SELECT o.id, o.order_no, o.ready_at, o.promised_pickup_at, o.delivery_address, o.quantity, o.unit, p.name AS product_name, so.name AS supplier_name, so.address AS supplier_address, so.region,
      (SELECT COUNT(*) FROM packages pk WHERE pk.order_id=o.id AND pk.status<>'CANCELLED')::int AS packages
    FROM orders o JOIN products p ON p.id=o.product_id JOIN organizations so ON so.id=o.supplier_id WHERE o.status='READY_FOR_PICKUP' ORDER BY o.promised_pickup_at`);
  const active = await q(pool, `${SHIP_SELECT} WHERE s.type='DELIVERY' AND s.status IN ('SCHEDULED','PICKED_UP','IN_TRANSIT','DELIVERY_FAILED') ORDER BY s.created_at DESC`);
  const couriers = await q(pool, `SELECT u.id, u.name, u.phone, o.name AS org_name FROM users u LEFT JOIN organizations o ON o.id=u.org_id WHERE u.role='COURIER' AND u.active ORDER BY u.name`);
  res.json({ ready, active, couriers });
}));

/** Dispatcher membuat shipment (jadwal) untuk order READY_FOR_PICKUP dan menugaskan kurir. OTP penerima dibuat di sini. */
courierRouter.post('/dispatch/orders/:id/assign', requirePerm('shipments.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ courier_user_id: z.string().uuid(), carrier: z.string().default('Supplier-ID Delivery'), vehicle: z.string().optional(), cold_chain: z.coerce.boolean().default(false), logistics_cost: z.coerce.number().min(0).optional() }), req.body);
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (o.status !== 'READY_FOR_PICKUP') throw conflict('ORDER_NOT_READY', { status: o.status });
  const courier = await one(pool, `SELECT * FROM users WHERE id=$1 AND role='COURIER' AND active`, [b.courier_user_id]);
  const row = await tx(async (c) => {
    const existing = await maybe(c, `SELECT * FROM shipments WHERE order_id=$1 AND type='DELIVERY' AND status IN ('SCHEDULED','PICKED_UP','IN_TRANSIT')`, [o.id]);
    if (existing) throw conflict('SHIPMENT_ALREADY_ACTIVE', { shipment_id: existing.id });
    const otp = generateOtp();
    const s = await one(c, `INSERT INTO shipments(order_id, type, status, carrier, driver_name, vehicle, cold_chain, tracking_no, logistics_cost, route, courier_user_id, otp_hash, otp_expires_at, manifest_no)
      VALUES ($1,'DELIVERY','SCHEDULED',$2,$3,$4,$5,$6,$7,'[]'::jsonb,$8,NULL,now() + interval '7 days',$9) RETURNING *`,
      [o.id, b.carrier, courier.name, b.vehicle ?? null, b.cold_chain, `TRK-${Date.now()}`, b.logistics_cost ?? Number(o.pricing_snapshot?.costBasis?.logisticsCost ?? 0), courier.id, `MAN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${courier.id.slice(0, 4).toUpperCase()}`]);
    await q(c, 'UPDATE shipments SET otp_hash=$2 WHERE id=$1', [s.id, hashOtp(otp, s.id)]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'ASSIGNED',$2)`, [s.id, `Kurir ${courier.name} ditugaskan`]);
    await q(c, `UPDATE packages SET shipment_id=$2 WHERE order_id=$1 AND status<>'CANCELLED'`, [o.id, s.id]);
    await notify(c, { userId: courier.id, kind: 'MANIFEST', title: `Pickup ${o.order_no}`, body: o.delivery_address ?? '', link: `/courier/shipments/${s.id}` });
    await notify(c, { orgId: o.buyer_id, kind: 'OTP', title: `Kode penerimaan pesanan ${o.order_no}`, body: `Berikan kode OTP ${otp} kepada kurir saat barang diterima.`, link: `/orders/${o.id}` });
    return { shipment: s, otp_sent_to_buyer: true };
  });
  res.status(201).json(row);
}));

/** Buyer melihat OTP penerimaan (dibuat ulang bila kedaluwarsa). */
courierRouter.get('/orders/:id/delivery-otp', requireRole('BUYER'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (o.buyer_id !== req.user!.orgId) throw forbidden();
  const s = await maybe(pool, `SELECT * FROM shipments WHERE order_id=$1 AND type='DELIVERY' AND status IN ('SCHEDULED','PICKED_UP','IN_TRANSIT','DELIVERY_FAILED','ARRIVED') ORDER BY created_at DESC LIMIT 1`, [o.id]);
  if (!s) throw conflict('NO_ACTIVE_SHIPMENT');
  const otp = generateOtp(); // OTP tidak disimpan plaintext; setiap permintaan buyer menerbitkan OTP baru yang menggantikan hash lama
  await q(pool, 'UPDATE shipments SET otp_hash=$2, otp_expires_at=now() + interval \'7 days\', otp_attempts=0 WHERE id=$1', [s.id, hashOtp(otp, s.id)]);
  res.json({ shipment_id: s.id, otp, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), note: 'Berikan kode ini kepada kurir saat menerima barang.' });
}));

/** Manifest kurir. */
courierRouter.get('/courier/shipments', requireRole('COURIER', 'ADMIN'), asyncH(async (req, res) => {
  const where = req.user!.role === 'COURIER' ? 's.courier_user_id=$1' : '$1::text IS NOT NULL';
  const rows = await q(pool, `${SHIP_SELECT} WHERE ${where} AND s.type='DELIVERY' ORDER BY CASE s.status WHEN 'SCHEDULED' THEN 0 WHEN 'PICKED_UP' THEN 1 WHEN 'IN_TRANSIT' THEN 2 WHEN 'DELIVERY_FAILED' THEN 3 ELSE 9 END, s.created_at DESC LIMIT 300`, [req.user!.role === 'COURIER' ? req.user!.id : 'all']);
  res.json(rows);
}));
courierRouter.get('/courier/shipments/:id', requireRole('COURIER', 'ADMIN', 'SUPPLIER', 'BUYER'), asyncH(async (req, res) => {
  const s = await one(pool, `${SHIP_SELECT} WHERE s.id=$1`, [req.params.id]);
  const u = req.user!;
  if (u.role === 'COURIER' && s.courier_user_id !== u.id) throw forbidden();
  if (u.role === 'SUPPLIER' && s.supplier_id !== u.orgId) throw forbidden();
  if (u.role === 'BUYER' && s.buyer_id !== u.orgId) throw forbidden();
  const events = await q(pool, 'SELECT * FROM shipment_events WHERE shipment_id=$1 ORDER BY occurred_at', [s.id]);
  res.json({ ...s, events, otp_hash: undefined });
}));

async function assertCourier(shipmentId: string, u: any) {
  const s = await one(pool, 'SELECT * FROM shipments WHERE id=$1', [shipmentId]);
  if (u.role === 'COURIER' && s.courier_user_id !== u.id) throw forbidden();
  if (!['COURIER', 'ADMIN'].includes(u.role)) throw forbidden();
  return s;
}

/** PICKUP: semua paket harus sudah dipindai (status PICKED_UP) → shipment PICKED_UP, order PICKED_UP, biaya logistik dicatat. */
courierRouter.post('/courier/shipments/:id/pickup', requireRole('COURIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await assertCourier(req.params.id, req.user!);
  if (s.status !== 'SCHEDULED') throw conflict('SHIPMENT_NOT_SCHEDULED', { status: s.status });
  const row = await tx(async (c) => {
    const pk = await q(c, `SELECT package_no, status FROM packages WHERE shipment_id=$1 AND status<>'CANCELLED'`, [s.id]);
    const notScanned = pk.filter((p) => p.status !== 'PICKED_UP');
    if (!pk.length) throw conflict('NO_PACKAGES');
    if (notScanned.length) throw conflict('PACKAGES_NOT_SCANNED', { packages: notScanned.map((p) => p.package_no) });
    await q(c, `UPDATE shipments SET status='PICKED_UP', pickup_at=now() WHERE id=$1`, [s.id]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'PICKUP',$2)`, [s.id, `${pk.length} paket diambil kurir`]);
    const o = await transition(c, s.order_id, 'PICKED_UP', req.user!.id, 'Diambil kurir', ', picked_up_at=now()');
    await postLogisticsCost(c, o, Number(s.logistics_cost));
    await notify(c, { orgId: o.buyer_id, kind: 'SHIPPED', title: `Pesanan ${o.order_no} dalam pengiriman`, link: `/orders/${o.id}` });
    return o;
  });
  res.json(row);
}));

/** Tracking event oleh kurir. */
courierRouter.post('/courier/shipments/:id/events', requireRole('COURIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await assertCourier(req.params.id, req.user!);
  const b = parse(z.object({ event_type: z.string().default('CHECKPOINT'), location: z.string().optional(), lat: z.coerce.number().optional(), lng: z.coerce.number().optional(), temperature_c: z.coerce.number().optional(), note: z.string().optional() }), req.body ?? {});
  const row = await tx(async (c) => {
    const ev = await one(c, `INSERT INTO shipment_events(shipment_id, event_type, location, lat, lng, temperature_c, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [s.id, b.event_type, b.location ?? null, b.lat ?? null, b.lng ?? null, b.temperature_c ?? null, b.note ?? null]);
    await q(c, `UPDATE shipments SET status='IN_TRANSIT', route = route || jsonb_build_array(jsonb_build_object('location',$2::text,'lat',$3::numeric,'lng',$4::numeric,'at',now())) WHERE id=$1 AND status IN ('PICKED_UP','IN_TRANSIT')`, [s.id, b.location ?? null, b.lat ?? null, b.lng ?? null]);
    await q(c, `UPDATE packages SET status='IN_TRANSIT' WHERE shipment_id=$1 AND status='PICKED_UP'`, [s.id]);
    const o = await one(c, 'SELECT status FROM orders WHERE id=$1', [s.order_id]);
    if (o.status === 'PICKED_UP') await transition(c, s.order_id, 'IN_TRANSIT', req.user!.id, b.location ?? 'Dalam perjalanan');
    return ev;
  });
  res.status(201).json(row);
}));

/**
 * SERAH TERIMA: OTP penerima (sah → jendela konfirmasi dimulai) atau foto bukti (DELIVERY_PROOF) tanpa OTP → tiba, menunggu verifikasi ops.
 * Semua paket harus dipindai DELIVER sebelumnya.
 */
courierRouter.post('/courier/shipments/:id/deliver', requireRole('COURIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await assertCourier(req.params.id, req.user!);
  if (!['PICKED_UP', 'IN_TRANSIT', 'DELIVERY_FAILED'].includes(s.status)) throw conflict('SHIPMENT_NOT_IN_DELIVERY', { status: s.status });
  const b = parse(z.object({ otp: z.string().regex(/^\d{6}$/).optional(), recipient_name: z.string().min(2), note: z.string().optional() }), req.body);
  const row = await tx(async (c) => {
    const pk = await q(c, `SELECT package_no, status FROM packages WHERE shipment_id=$1 AND status<>'CANCELLED'`, [s.id]);
    const notScanned = pk.filter((p) => p.status !== 'DELIVERED');
    if (notScanned.length) throw conflict('PACKAGES_NOT_SCANNED', { packages: notScanned.map((p) => p.package_no) });
    const proofs = await q(c, `SELECT id FROM evidence_files WHERE shipment_id=$1 AND kind='DELIVERY_PROOF'`, [s.id]);
    let otpOk = false;
    if (b.otp) {
      if (s.otp_attempts >= 5) throw conflict('OTP_LOCKED');
      if (s.otp_expires_at && new Date(s.otp_expires_at) < new Date()) throw conflict('OTP_EXPIRED');
      otpOk = hashOtp(b.otp, s.id) === s.otp_hash;
      if (!otpOk) { await q(c, 'UPDATE shipments SET otp_attempts=otp_attempts+1 WHERE id=$1', [s.id]); throw bad('OTP_INVALID', { attempts_left: 4 - s.otp_attempts }); }
    }
    const otpRequired = await getSetting(c, 'delivery.otp_required', true);
    if (!otpOk && !proofs.length) throw bad('DELIVERY_EVIDENCE_REQUIRED', 'Masukkan OTP penerima atau unggah foto bukti penerimaan');
    const evidence = { method: otpOk ? 'OTP' : 'PHOTO', recipient_name: b.recipient_name, evidence_ids: proofs.map((p) => p.id), verified: otpOk, note: b.note ?? null, courier_user_id: req.user!.id };
    await q(c, `UPDATE shipments SET status='ARRIVED', arrived_at=now(), delivered_at=now(), recipient_name=$2, delivery_evidence=$3::jsonb WHERE id=$1`, [s.id, b.recipient_name, JSON.stringify(evidence)]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'DELIVERED',$2)`, [s.id, otpOk ? `Diterima ${b.recipient_name} (OTP terverifikasi)` : `Diserahkan ke ${b.recipient_name} (foto; menunggu verifikasi ops)`]);
    let o = await transition(c, s.order_id, 'ARRIVED_WAITING_INSPECTION', req.user!.id, otpOk ? 'Diterima dengan OTP; jendela konfirmasi dimulai' : 'Diserahkan dengan foto bukti; bukti menunggu verifikasi', ', arrived_at=now(), delivery_attempts=delivery_attempts+1');
    if (otpOk) o = await startConfirmationWindow(c, o.id, req.user!.id, 'OTP');
    else {
      await q(c, `UPDATE orders SET needs_ops_review=TRUE WHERE id=$1`, [o.id]);
      await q(c, `INSERT INTO escalations(order_id, kind, reason) VALUES ($1,'EVIDENCE_INVALID',$2)`, [o.id, otpRequired ? 'Serah terima tanpa OTP; verifikasi foto bukti kurir' : 'Verifikasi foto bukti kurir']);
    }
    return { order: o, evidence };
  });
  res.json(row);
}));

/** GAGAL ANTAR: alasan wajib; percobaan dihitung; melebihi batas → eskalasi ops (kirim ulang / batal+refund). */
courierRouter.post('/courier/shipments/:id/fail', requireRole('COURIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await assertCourier(req.params.id, req.user!);
  if (!['PICKED_UP', 'IN_TRANSIT'].includes(s.status)) throw conflict('SHIPMENT_NOT_IN_DELIVERY', { status: s.status });
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  const row = await tx(async (c) => {
    const max = Number(await getSetting(c, 'delivery.max_attempts', 2));
    const upd = await one(c, `UPDATE shipments SET status='DELIVERY_FAILED', failed_attempts=failed_attempts+1, last_failure_reason=$2 WHERE id=$1 RETURNING *`, [s.id, b.reason]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'DELIVERY_FAILED',$2)`, [s.id, b.reason]);
    const o = await transition(c, s.order_id, 'DELIVERY_FAILED', req.user!.id, `Gagal antar: ${b.reason}`, ', delivery_attempts=delivery_attempts+1');
    if (upd.failed_attempts >= max) {
      await q(c, `UPDATE orders SET needs_ops_review=TRUE WHERE id=$1`, [o.id]);
      await q(c, `INSERT INTO escalations(order_id, kind, reason) VALUES ($1,'DELIVERY_FAILED',$2)`, [o.id, `Gagal antar ${upd.failed_attempts}× — ${b.reason}`]);
    }
    await notify(c, { orgId: o.buyer_id, kind: 'DELIVERY_FAILED', title: `Pengiriman ${o.order_no} gagal`, body: b.reason, link: `/orders/${o.id}` });
    return { shipment: upd, order: o, escalated: upd.failed_attempts >= max };
  });
  res.json(row);
}));
/** Kirim ulang (kurir/dispatcher) setelah gagal antar. */
courierRouter.post('/courier/shipments/:id/redeliver', requireRole('COURIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await assertCourier(req.params.id, req.user!);
  if (s.status !== 'DELIVERY_FAILED') throw conflict('SHIPMENT_NOT_FAILED');
  const row = await tx(async (c) => {
    await q(c, `UPDATE shipments SET status='IN_TRANSIT' WHERE id=$1`, [s.id]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'REDELIVERY','Pengiriman ulang')`, [s.id]);
    return transition(c, s.order_id, 'IN_TRANSIT', req.user!.id, 'Pengiriman ulang');
  });
  res.json(row);
}));

/** Ops memverifikasi foto bukti kurir → bukti sah, jendela konfirmasi dimulai. */
courierRouter.post('/admin/shipments/:id/verify-evidence', requirePerm('orders.manage', 'shipments.manage'), asyncH(async (req, res) => {
  const b = parse(z.object({ valid: z.coerce.boolean(), note: z.string().optional() }), req.body);
  const s = await one(pool, 'SELECT * FROM shipments WHERE id=$1', [req.params.id]);
  const row = await tx(async (c) => {
    const ev = { ...(s.delivery_evidence ?? {}), verified: b.valid, verified_by: req.user!.id, verified_at: new Date().toISOString(), verify_note: b.note ?? null };
    await q(c, 'UPDATE shipments SET delivery_evidence=$2::jsonb WHERE id=$1', [s.id, JSON.stringify(ev)]);
    await q(c, `UPDATE escalations SET status='RESOLVED', resolved_by=$2, resolution=$3, resolved_at=now() WHERE order_id=$1 AND kind='EVIDENCE_INVALID' AND status='OPEN'`, [s.order_id, req.user!.id, b.valid ? 'Bukti foto diverifikasi sah' : `Bukti tidak sah: ${b.note ?? ''}`]);
    if (b.valid) {
      await q(c, `UPDATE orders SET needs_ops_review=FALSE WHERE id=$1`, [s.order_id]);
      return startConfirmationWindow(c, s.order_id, req.user!.id, 'PHOTO_VERIFIED');
    }
    await q(c, `UPDATE orders SET hold_reason=$2 WHERE id=$1`, [s.order_id, `Bukti penerimaan tidak sah: ${b.note ?? ''}`]);
    return one(c, 'SELECT * FROM orders WHERE id=$1', [s.order_id]);
  });
  res.json(row);
}));
