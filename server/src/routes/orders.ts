import { Router } from 'express';
import { z } from 'zod';
import { Db, pool, q, one, maybe, tx, nextNo } from '../db';
import { asyncH, parse, bad, forbidden, requireRole, conflict, money } from '../lib/http';
import { getSetting } from '../services/config';
import { priceOrder, transition, weightOf } from '../services/orders';
import { postBuyerPayment, postProviderFee, postPackagingCost, postLogisticsCost, postJournal, reconcile } from '../services/ledger';
import { recomputeQualityScore } from '../services/quality';
import { runEligibilityCheck } from '../services/returns';

export const ordersRouter = Router();

async function loadCtx(db: Db, batchId: string, buyerId: string) {
  const batch = await one(db, 'SELECT * FROM batches WHERE id=$1', [batchId]);
  const supplierOrg = await one(db, 'SELECT * FROM organizations WHERE id=$1', [batch.supplier_id]);
  const buyerOrg = await one(db, 'SELECT * FROM organizations WHERE id=$1', [buyerId]);
  const category = await one(db, 'SELECT c.id, c.tax_class FROM categories c JOIN products p ON p.category_id=c.id WHERE p.id=$1', [batch.product_id]);
  return { batch, supplierOrg, buyerOrg, category };
}

export async function createDraftOrder(db: Db, a: {
  buyerId: string; batchId: string; quantity: number; unitPrice?: number; distanceKm: number; deliveryAddress?: string | null;
  optionalServiceCodes: string[]; promoCode: string | null; rfqId?: string | null; quotationId?: string | null;
}) {
  const ctx = await loadCtx(db, a.batchId, a.buyerId);
  if (ctx.batch.status !== 'READY_FOR_ORDER') throw conflict('BATCH_NOT_READY_FOR_ORDER', { status: ctx.batch.status });
  if (a.quantity > Number(ctx.batch.available_quantity)) throw conflict('INSUFFICIENT_QUANTITY', { available: ctx.batch.available_quantity });
  if (['SUSPENDED', 'UNDER_REVIEW'].includes(ctx.supplierOrg.status)) throw conflict('SUPPLIER_RESTRICTED');
  const unitPrice = a.unitPrice ?? Number(ctx.batch.price_per_unit);
  const pr = await priceOrder(db, { ...ctx, quantity: a.quantity, unitPrice, distanceKm: a.distanceKm, optionalServiceCodes: a.optionalServiceCodes, promoCode: a.promoCode });
  const orderNo = await nextNo(db, 'order', 'SO');
  return one(db,
    `INSERT INTO orders(order_no, buyer_id, supplier_id, product_id, batch_id, rfq_id, quotation_id, status, quantity, unit, unit_price, weight_kg, distance_km,
       delivery_address, optional_services, promo_code, product_value, platform_fee_rate, platform_fee_amount, packaging_amount, logistics_amount, payment_fee_amount,
       optional_amount, discount_amount, tax_amount, total_amount, pricing_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb) RETURNING *`,
    [orderNo, a.buyerId, ctx.batch.supplier_id, ctx.batch.product_id, ctx.batch.id, a.rfqId ?? null, a.quotationId ?? null, a.quantity, ctx.batch.unit, unitPrice,
      weightOf(ctx.batch, a.quantity), a.distanceKm, a.deliveryAddress ?? null, JSON.stringify(pr.optionalLines), a.promoCode,
      pr.productValue, pr.platformFeeRate, pr.platformFeeAmount, pr.packagingAmount, pr.logisticsAmount, pr.paymentFeeAmount, pr.optionalAmount,
      pr.discountAmount, pr.taxAmount, pr.totalAmount, JSON.stringify({ ...pr, preview: true })]);
}

const previewSchema = z.object({
  batch_id: z.string().uuid(), quantity: z.coerce.number().positive(), unit_price: z.coerce.number().positive().optional(),
  distance_km: z.coerce.number().min(0).default(0), optional_service_codes: z.array(z.string()).default([]), promo_code: z.string().optional(),
  delivery_address: z.string().optional(),
});

/** ORDER SUMMARY transparan sebelum bayar (tanpa menyimpan). */
ordersRouter.post('/orders/preview', requireRole('BUYER', 'ADMIN'), asyncH(async (req, res) => {
  const b = parse(previewSchema, req.body);
  const ctx = await loadCtx(pool, b.batch_id, req.user!.orgId!);
  const pr = await priceOrder(pool, { ...ctx, quantity: b.quantity, unitPrice: b.unit_price ?? Number(ctx.batch.price_per_unit), distanceKm: b.distance_km, optionalServiceCodes: b.optional_service_codes, promoCode: b.promo_code ?? null });
  res.json(pr);
}));

/** Pembelian langsung dari listing (tanpa RFQ). */
ordersRouter.post('/orders', requireRole('BUYER'), asyncH(async (req, res) => {
  const b = parse(previewSchema, req.body);
  const o = await tx((c) => createDraftOrder(c, { buyerId: req.user!.orgId!, batchId: b.batch_id, quantity: b.quantity, unitPrice: b.unit_price, distanceKm: b.distance_km, deliveryAddress: b.delivery_address, optionalServiceCodes: b.optional_service_codes, promoCode: b.promo_code ?? null }));
  res.status(201).json(o);
}));

ordersRouter.get('/orders', requireRole(), asyncH(async (req, res) => {
  const u = req.user!;
  const where = u.role === 'BUYER' ? 'o.buyer_id=$1' : u.role === 'SUPPLIER' ? 'o.supplier_id=$1' : '$1::text IS NOT NULL';
  res.json(await q(pool,
    `SELECT o.*, p.name AS product_name, so.name AS supplier_name, bo.name AS buyer_name, b.batch_code
     FROM orders o JOIN products p ON p.id=o.product_id JOIN organizations so ON so.id=o.supplier_id JOIN organizations bo ON bo.id=o.buyer_id JOIN batches b ON b.id=o.batch_id
     WHERE ${where} ORDER BY o.created_at DESC`, [u.role === 'ADMIN' ? 'all' : u.orgId]));
}));

export async function orderDetail(db: Db, id: string) {
  const o = await one(db,
    `SELECT o.*, p.name AS product_name, p.commodity, so.name AS supplier_name, so.tax_status AS supplier_tax_status, bo.name AS buyer_name, b.batch_code, b.grade AS batch_grade,
            b.harvest_date AS batch_harvest_date, b.expected_weight_kg AS batch_expected_weight_kg, b.condition AS batch_condition
     FROM orders o JOIN products p ON p.id=o.product_id JOIN organizations so ON so.id=o.supplier_id JOIN organizations bo ON bo.id=o.buyer_id JOIN batches b ON b.id=o.batch_id WHERE o.id=$1`, [id]);
  const [events, payments, shipments, inspection, returnCases, ledger, evidence, adjustments] = await Promise.all([
    q(db, 'SELECT * FROM order_events WHERE order_id=$1 ORDER BY created_at', [id]),
    q(db, 'SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at', [id]),
    q(db, `SELECT s.*, (SELECT json_agg(e ORDER BY e.occurred_at) FROM shipment_events e WHERE e.shipment_id=s.id) AS events FROM shipments s WHERE order_id=$1 ORDER BY created_at`, [id]),
    maybe(db, 'SELECT * FROM inspections WHERE order_id=$1', [id]),
    q(db, 'SELECT * FROM return_cases WHERE order_id=$1 ORDER BY created_at', [id]),
    q(db, 'SELECT e.*, j.journal_type FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE e.order_id=$1 ORDER BY e.posted_at, e.side DESC', [id]),
    q(db, 'SELECT * FROM evidence_files WHERE order_id=$1 OR batch_id=$2 ORDER BY uploaded_at', [id, o.batch_id]),
    q(db, 'SELECT * FROM financial_adjustments WHERE order_id=$1 ORDER BY created_at', [id]),
  ]);
  return { ...o, events, payments, shipments, inspection, return_cases: returnCases, ledger, evidence, adjustments };
}

ordersRouter.get('/orders/:id', requireRole(), asyncH(async (req, res) => {
  const d = await orderDetail(pool, req.params.id);
  const u = req.user!;
  if (u.role === 'BUYER' && d.buyer_id !== u.orgId) throw forbidden();
  if (u.role === 'SUPPLIER' && d.supplier_id !== u.orgId) throw forbidden();
  res.json(d);
}));

/** KONFIRMASI: kunci PRICING SNAPSHOT (rate & nominal saat ini). Perubahan fee di kemudian hari tidak mengubah order ini. */
ordersRouter.post('/orders/:id/confirm', requireRole('BUYER'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (o.buyer_id !== req.user!.orgId) throw forbidden();
  const row = await tx(async (c) => {
    const ctx = await loadCtx(c, o.batch_id, o.buyer_id);
    const b = await one(c, 'SELECT * FROM batches WHERE id=$1 FOR UPDATE', [o.batch_id]);
    if (b.status !== 'READY_FOR_ORDER' || Number(b.available_quantity) < Number(o.quantity)) throw conflict('INSUFFICIENT_QUANTITY');
    const now = new Date();
    const pr = await priceOrder(c, { ...ctx, quantity: Number(o.quantity), unitPrice: Number(o.unit_price), distanceKm: Number(o.distance_km), optionalServiceCodes: (o.optional_services as any[]).map((x) => x.code), promoCode: o.promo_code, at: now });
    await q(c, 'UPDATE batches SET available_quantity=available_quantity-$2, status=CASE WHEN available_quantity-$2<=0 THEN \'SOLD_OUT\' ELSE status END WHERE id=$1', [b.id, o.quantity]);
    const lead = Number(await getSetting(c, 'fulfillment.pickup_lead_hours', 48));
    return transition(c, o.id, 'PENDING_PAYMENT', req.user!.id, 'Order dikonfirmasi; pricing snapshot terkunci',
      `, pricing_locked_at=now(), confirmed_at=now(), fee_config_id='${pr.feeConfig.id}', platform_fee_rate=${pr.platformFeeRate}, product_value=${pr.productValue},
        platform_fee_amount=${pr.platformFeeAmount}, packaging_amount=${pr.packagingAmount}, logistics_amount=${pr.logisticsAmount}, payment_fee_amount=${pr.paymentFeeAmount},
        optional_amount=${pr.optionalAmount}, discount_amount=${pr.discountAmount}, tax_amount=${pr.taxAmount}, total_amount=${pr.totalAmount},
        promised_pickup_at=now() + interval '${lead} hours',
        pricing_snapshot='${JSON.stringify({ ...pr, locked_at: now.toISOString(), fee_config: pr.feeConfig }).replace(/'/g, "''")}'::jsonb`);
  });
  res.json(row);
}));

/** PEMBAYARAN (mock gateway): kas masuk → ledger BUYER_PAYMENT + PROVIDER_FEE. */
ordersRouter.post('/orders/:id/pay', requireRole('BUYER', 'ADMIN'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (req.user!.role === 'BUYER' && o.buyer_id !== req.user!.orgId) throw forbidden();
  const { channel } = parse(z.object({ channel: z.string().default('VA') }), req.body ?? {});
  const row = await tx(async (c) => {
    const providerFee = money(Number(o.pricing_snapshot?.costBasis?.providerFee ?? 0));
    const pay = await one(c,
      `INSERT INTO payments(order_id, provider, channel, amount, provider_fee, status, provider_ref, paid_at) VALUES ($1,'MOCK_GATEWAY',$2,$3,$4,'PAID',$5,now()) RETURNING *`,
      [o.id, channel, o.total_amount, providerFee, `MOCK-${Date.now()}`]);
    const upd = await transition(c, o.id, 'PAID', req.user!.id, `Pembayaran ${pay.provider_ref} via ${channel}`, ', paid_at=now()');
    await postBuyerPayment(c, upd, req.user!.id);
    await postProviderFee(c, upd, providerFee);
    return { order: upd, payment: pay };
  });
  res.json(row);
}));

/** PACKING oleh supplier → biaya packaging aktual dicatat (beban). */
ordersRouter.post('/orders/:id/pack', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (req.user!.role === 'SUPPLIER' && o.supplier_id !== req.user!.orgId) throw forbidden();
  const { packaging_type, actual_packaging_cost } = parse(z.object({ packaging_type: z.string().default('Karung/Box standar'), actual_packaging_cost: z.coerce.number().min(0).optional() }), req.body ?? {});
  const row = await tx(async (c) => {
    const upd = await transition(c, o.id, 'PACKING', req.user!.id, `Packing: ${packaging_type}`, ', packed_at=now()');
    const cost = actual_packaging_cost ?? Number(o.pricing_snapshot?.costBasis?.packagingCost ?? 0);
    await postPackagingCost(c, upd, cost);
    await q(c, `UPDATE orders SET pricing_snapshot = pricing_snapshot || jsonb_build_object('packaging_type',$2::text,'actual_packaging_cost',$3::numeric) WHERE id=$1`, [o.id, packaging_type, cost]);
    return upd;
  });
  res.json(row);
}));

/** PICKUP → shipment dibuat, biaya logistik ke penyedia dicatat sebagai utang. */
ordersRouter.post('/orders/:id/pickup', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (req.user!.role === 'SUPPLIER' && o.supplier_id !== req.user!.orgId) throw forbidden();
  const b = parse(z.object({ carrier: z.string().default('Supplier.id Logistics Partner'), driver_name: z.string().optional(), vehicle: z.string().optional(), packaging_type: z.string().optional(), cold_chain: z.coerce.boolean().default(false), logistics_cost: z.coerce.number().min(0).optional() }), req.body ?? {});
  const row = await tx(async (c) => {
    const cost = b.logistics_cost ?? Number(o.pricing_snapshot?.costBasis?.logisticsCost ?? 0);
    const s = await one(c,
      `INSERT INTO shipments(order_id, type, status, carrier, driver_name, vehicle, packaging_type, cold_chain, tracking_no, pickup_at, logistics_cost, route)
       VALUES ($1,'DELIVERY','PICKED_UP',$2,$3,$4,$5,$6,$7,now(),$8,'[]'::jsonb) RETURNING *`,
      [o.id, b.carrier, b.driver_name ?? null, b.vehicle ?? null, b.packaging_type ?? o.pricing_snapshot?.packaging_type ?? null, b.cold_chain, `TRK-${Date.now()}`, cost]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'PICKUP','Barang diambil dari supplier')`, [s.id]);
    const upd = await transition(c, o.id, 'PICKED_UP', req.user!.id, `Pickup oleh ${b.carrier}`, ', picked_up_at=now()');
    await postLogisticsCost(c, upd, cost);
    return { order: upd, shipment: s };
  });
  res.json(row);
}));

/** LIVE TRACKING event. */
ordersRouter.post('/shipments/:id/events', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await one(pool, 'SELECT * FROM shipments WHERE id=$1', [req.params.id]);
  const b = parse(z.object({ event_type: z.string().default('CHECKPOINT'), location: z.string().optional(), lat: z.coerce.number().optional(), lng: z.coerce.number().optional(), temperature_c: z.coerce.number().optional(), note: z.string().optional() }), req.body ?? {});
  const row = await tx(async (c) => {
    const ev = await one(c, `INSERT INTO shipment_events(shipment_id, event_type, location, lat, lng, temperature_c, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [s.id, b.event_type, b.location ?? null, b.lat ?? null, b.lng ?? null, b.temperature_c ?? null, b.note ?? null]);
    await q(c, `UPDATE shipments SET status='IN_TRANSIT', route = route || jsonb_build_array(jsonb_build_object('location',$2::text,'lat',$3::numeric,'lng',$4::numeric,'at',now())) WHERE id=$1 AND status IN ('PICKED_UP','IN_TRANSIT')`, [s.id, b.location ?? null, b.lat ?? null, b.lng ?? null]);
    if (s.type === 'DELIVERY') {
      const o = await one(c, 'SELECT status FROM orders WHERE id=$1', [s.order_id]);
      if (o.status === 'PICKED_UP') await transition(c, s.order_id, 'IN_TRANSIT', req.user!.id, b.location ?? 'Dalam perjalanan');
    } else {
      await q(c, `UPDATE return_cases SET status='IN_TRANSIT' WHERE id=$1 AND status='PICKUP_SCHEDULED'`, [s.return_case_id]);
    }
    return ev;
  });
  res.status(201).json(row);
}));

/** ARRIVED — WAITING FOR INSPECTION. */
ordersRouter.post('/shipments/:id/arrive', requireRole('SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const s = await one(pool, 'SELECT * FROM shipments WHERE id=$1 AND type=\'DELIVERY\'', [req.params.id]);
  const row = await tx(async (c) => {
    await q(c, `UPDATE shipments SET status='ARRIVED', arrived_at=now() WHERE id=$1`, [s.id]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'ARRIVED','Tiba di lokasi buyer — menunggu inspeksi')`, [s.id]);
    return transition(c, s.order_id, 'ARRIVED_WAITING_INSPECTION', req.user!.id, 'Driver tiba; menunggu inspeksi buyer', ', arrived_at=now()');
  });
  res.json(row);
}));

/** BUYER INSPECTION: ACCEPT / PARTIAL ACCEPT / REJECT. Klaim wajib foto + video (owner_type INSPECTION). */
ordersRouter.post('/orders/:id/inspection', requireRole('BUYER'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (o.buyer_id !== req.user!.orgId) throw forbidden();
  if (o.status !== 'ARRIVED_WAITING_INSPECTION') throw conflict('NOT_WAITING_INSPECTION', { status: o.status });
  const b = parse(z.object({
    decision: z.enum(['ACCEPT', 'PARTIAL_ACCEPT', 'REJECT']),
    accepted_quantity: z.coerce.number().min(0).optional(),
    reason_code: z.string().optional(), description: z.string().optional(),
    measured_weight_kg: z.coerce.number().optional(), measured_temperature_c: z.coerce.number().optional(), notes: z.string().optional(),
  }), req.body);
  const qty = Number(o.quantity);
  const accepted = b.decision === 'ACCEPT' ? qty : b.decision === 'REJECT' ? 0 : Number(b.accepted_quantity);
  if (b.decision === 'PARTIAL_ACCEPT' && !(accepted > 0 && accepted < qty)) throw bad('PARTIAL_QUANTITY_INVALID');
  const rejected = money(qty - accepted);
  const ship = await one(pool, `SELECT * FROM shipments WHERE order_id=$1 AND type='DELIVERY' ORDER BY created_at DESC LIMIT 1`, [o.id]);
  if (rejected > 0) {
    if (!b.reason_code) throw bad('REASON_CODE_REQUIRED');
    await one(pool, 'SELECT code FROM return_reason_codes WHERE code=$1 AND active', [b.reason_code]).catch(() => { throw bad('INVALID_REASON_CODE'); });
    const ev = await q(pool, `SELECT kind FROM evidence_files WHERE order_id=$1 AND owner_type='INSPECTION'`, [o.id]);
    const hasPhoto = ev.some((e) => e.kind === 'RECEIVING_PHOTO');
    const hasVideo = ev.some((e) => e.kind === 'RECEIVING_VIDEO');
    const requireVideo = await getSetting(pool, 'return.require_video', true);
    if (!hasPhoto || (requireVideo && !hasVideo)) throw bad('RECEIVING_EVIDENCE_REQUIRED', { photo: hasPhoto, video: hasVideo, message: 'Klaim wajib foto + video kondisi barang saat diterima' });
  }
  const result = await tx(async (c) => {
    const insp = await one(c,
      `INSERT INTO inspections(order_id, shipment_id, buyer_id, inspector_id, decision, accepted_quantity, rejected_quantity, measured_weight_kg, measured_temperature_c, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [o.id, ship.id, o.buyer_id, req.user!.id, b.decision, accepted, rejected, b.measured_weight_kg ?? null, b.measured_temperature_c ?? null, b.notes ?? null]);
    await q(c, `UPDATE evidence_files SET inspection_id=$2 WHERE order_id=$1 AND owner_type='INSPECTION'`, [o.id, insp.id]);
    await q(c, `UPDATE shipments SET status='DELIVERED' WHERE id=$1`, [ship.id]);
    await q(c, `INSERT INTO shipment_events(shipment_id, event_type, note) VALUES ($1,'DELIVERED',$2)`, [ship.id, `Inspeksi buyer: ${b.decision}`]);
    const to = b.decision === 'ACCEPT' ? 'ACCEPTED' : b.decision === 'REJECT' ? 'REJECTED' : 'PARTIALLY_ACCEPTED';
    let order = await transition(c, o.id, to, req.user!.id, `Inspeksi: ${b.decision} (diterima ${accepted}, ditolak ${rejected})`, `, inspected_at=now(), accepted_quantity=${accepted}, rejected_quantity=${rejected}`);
    let returnCase = null;
    if (rejected > 0) {
      returnCase = await one(c,
        `INSERT INTO return_cases(case_no, order_id, inspection_id, shipment_id, batch_id, buyer_id, supplier_id, status, reason_code, description, quantity_affected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'REQUESTED',$8,$9,$10) RETURNING *`,
        [await nextNo(c, 'return', 'RET'), o.id, insp.id, ship.id, o.batch_id, o.buyer_id, o.supplier_id, b.reason_code, b.description ?? null, rejected]);
      await q(c, `UPDATE evidence_files SET return_case_id=$2 WHERE order_id=$1 AND owner_type='INSPECTION'`, [o.id, returnCase.id]);
      returnCase = await runEligibilityCheck(c, returnCase.id);
    } else {
      // Full acceptance → langsung SETTLED (hak supplier final; payout menyusul)
      order = await transition(c, o.id, 'SETTLED', req.user!.id, 'Diterima penuh; siap payout', ', settled_at=now()');
    }
    return { order, inspection: insp, return_case: returnCase };
  });
  await recomputeQualityScore(pool, o.supplier_id);
  res.json(result);
}));

/** CANCEL: sebelum bayar → batal saja; setelah bayar & sebelum pickup → refund penuh (kecuali payment fee sesuai aturan provider). */
ordersRouter.post('/orders/:id/cancel', requireRole('BUYER', 'SUPPLIER', 'ADMIN'), asyncH(async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [req.params.id]);
  const u = req.user!;
  if (u.role === 'BUYER' && o.buyer_id !== u.orgId) throw forbidden();
  if (u.role === 'SUPPLIER' && o.supplier_id !== u.orgId) throw forbidden();
  const { reason } = parse(z.object({ reason: z.string().default('') }), req.body ?? {});
  const row = await tx(async (c) => {
    const upd = await transition(c, o.id, 'CANCELLED', u.id, `Dibatalkan oleh ${u.role}: ${reason}`, ', cancelled_at=now()');
    if (['PENDING_PAYMENT', 'PAID', 'PACKING'].includes(o.status)) {
      await q(c, `UPDATE batches SET available_quantity=available_quantity+$2, status=CASE WHEN status='SOLD_OUT' THEN 'READY_FOR_ORDER' ELSE status END WHERE id=$1`, [o.batch_id, o.quantity]);
    }
    if (['PAID', 'PACKING'].includes(o.status)) {
      const feeRefundable = await getSetting(c, 'payment.fee_refundable', false);
      const pfTax = Number((o.pricing_snapshot?.taxLines ?? []).find((t: any) => t.component === 'PAYMENT_FEE')?.amount ?? 0);
      const refund = money(Number(o.total_amount) - (feeRefundable ? 0 : Number(o.payment_fee_amount) + pfTax));
      const entries: any[] = [
        { account: 'SUPPLIER_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: Number(o.product_value), partyType: 'SUPPLIER', partyId: o.supplier_id },
        { account: 'PLATFORM_FEE_REVENUE', component: 'PLATFORM_FEE_REVENUE', side: 'DEBIT', amount: Number(o.platform_fee_amount), partyType: 'PLATFORM' },
        { account: 'PACKAGING_REVENUE', component: 'PACKAGING_REVENUE', side: 'DEBIT', amount: Number(o.packaging_amount), partyType: 'PLATFORM' },
        { account: 'LOGISTICS_REVENUE', component: 'LOGISTICS_REVENUE', side: 'DEBIT', amount: Number(o.logistics_amount), partyType: 'PLATFORM' },
        { account: 'OPTIONAL_SERVICE_REVENUE', component: 'OPTIONAL_SERVICE', side: 'DEBIT', amount: Number(o.optional_amount), partyType: 'PLATFORM' },
        { account: 'TAX_PAYABLE', component: 'TAX_PAYABLE', side: 'DEBIT', amount: money(Number(o.tax_amount) - (feeRefundable ? 0 : pfTax)), partyType: 'PLATFORM' },
        { account: 'PROMOTION_DISCOUNT', component: 'PROMOTION_DISCOUNT', side: 'CREDIT', amount: Number(o.discount_amount), partyType: 'PLATFORM' },
        { account: 'REFUND_PAYABLE', component: 'REFUND', side: 'CREDIT', amount: refund, partyType: 'BUYER', partyId: o.buyer_id },
      ];
      if (feeRefundable) entries.push({ account: 'PAYMENT_FEE_COLLECTED', component: 'PAYMENT_FEE', side: 'DEBIT', amount: Number(o.payment_fee_amount), partyType: 'PLATFORM' });
      const jid = await postJournal(c, { type: 'CANCELLATION', orderId: o.id, reference: o.order_no, createdBy: u.id, memo: 'Pembatalan setelah pembayaran' }, entries);
      await postJournal(c, { type: 'REFUND_PAID', orderId: o.id, reference: o.order_no, createdBy: u.id }, [
        { account: 'REFUND_PAYABLE', component: 'REFUND', side: 'DEBIT', amount: refund, partyType: 'BUYER', partyId: o.buyer_id },
        { account: 'CASH', component: 'CASH_OUT', side: 'CREDIT', amount: refund, partyType: 'BUYER', partyId: o.buyer_id },
      ]);
      await q(c, `INSERT INTO financial_adjustments(order_id, adjustment_type, components, refund_to_buyer, supplier_deduction, journal_id, created_by) VALUES ($1,'CANCELLATION',$2::jsonb,$3,$4,$5,$6)`,
        [o.id, JSON.stringify({ fee_refundable: feeRefundable }), refund, o.product_value, jid, u.id]);
      await q(c, `UPDATE payments SET status='REFUNDED' WHERE order_id=$1 AND status='PAID'`, [o.id]);
    }
    return upd;
  });
  await recomputeQualityScore(pool, o.supplier_id);
  res.json(row);
}));

ordersRouter.get('/orders/:id/reconcile', requireRole('ADMIN'), asyncH(async (req, res) => {
  res.json(await reconcile(pool, req.params.id));
}));
