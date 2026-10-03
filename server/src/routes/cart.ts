/**
 * KERANJANG & CHECKOUT (pelanggan B2C/B2B): multi-item/multi-mitra → order induk (order_groups) + suborder per batch (orders).
 * Checkout = kunci harga + reservasi stok atomik per suborder + tenggat bayar; pembayaran di muka (keputusan #2) di level order induk.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, maybe, tx, nextNo } from '../db';
import { asyncH, parse, bad, conflict, forbidden, requireRole, money } from '../lib/http';
import { getSetting } from '../services/config';
import { createDraftOrder, confirmOrder } from './orders';
import { transition } from '../services/orders';
import { postBuyerPayment, postProviderFee } from '../services/ledger';
import { createAcceptanceTask } from '../services/fulfillment';

export const cartRouter = Router();

const CART_SELECT = `SELECT ci.id, ci.batch_id, ci.quantity, ci.updated_at, b.batch_code, b.unit, b.price_per_unit, b.available_quantity, b.status AS batch_status, b.min_order_qty, b.weight_tolerance_pct,
    p.name AS product_name, p.image_url, p.commodity, c.code AS category_code, c.name AS category_name, c.trade_model, c.reseller_markup_pct, o.name AS supplier_name, o.region AS supplier_region,
    (SELECT file_path FROM evidence_files e WHERE e.batch_id=b.id AND e.owner_type='BATCH' ORDER BY e.uploaded_at LIMIT 1) AS photo
  FROM cart_items ci JOIN batches b ON b.id=ci.batch_id JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id JOIN organizations o ON o.id=b.supplier_id
  WHERE ci.buyer_id=$1 ORDER BY ci.updated_at DESC`;

function decorate(rows: any[]) {
  return rows.map((r) => {
    const sell = r.trade_model === 'RESELLER' ? money(Number(r.price_per_unit) * (1 + Number(r.reseller_markup_pct) / 100)) : Number(r.price_per_unit);
    return { ...r, unit_price: sell, line_total: money(sell * Number(r.quantity)), available: r.batch_status === 'READY_FOR_ORDER' && Number(r.available_quantity) >= Number(r.quantity) };
  });
}

cartRouter.get('/cart', requireRole('BUYER'), asyncH(async (req, res) => {
  const items = decorate(await q(pool, CART_SELECT, [req.user!.orgId]));
  res.json({ items, subtotal: money(items.reduce((s, i) => s + i.line_total, 0)), suppliers: Array.from(new Set(items.map((i) => i.supplier_name))).length });
}));

cartRouter.post('/cart/items', requireRole('BUYER'), asyncH(async (req, res) => {
  const b = parse(z.object({ batch_id: z.string().uuid(), quantity: z.coerce.number().positive() }), req.body);
  const batch = await one(pool, 'SELECT * FROM batches WHERE id=$1', [b.batch_id]);
  if (batch.status !== 'READY_FOR_ORDER') throw conflict('BATCH_NOT_READY_FOR_ORDER', { status: batch.status });
  if (b.quantity < Number(batch.min_order_qty ?? 1)) throw bad('BELOW_MIN_ORDER', { min_order_qty: batch.min_order_qty });
  if (b.quantity > Number(batch.available_quantity)) throw conflict('INSUFFICIENT_QUANTITY', { available: batch.available_quantity });
  await q(pool, `INSERT INTO cart_items(buyer_id, batch_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (buyer_id, batch_id) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`, [req.user!.orgId, b.batch_id, b.quantity]);
  res.status(201).json({ items: decorate(await q(pool, CART_SELECT, [req.user!.orgId])) });
}));

cartRouter.delete('/cart/items/:batchId', requireRole('BUYER'), asyncH(async (req, res) => {
  await q(pool, 'DELETE FROM cart_items WHERE buyer_id=$1 AND batch_id=$2', [req.user!.orgId, req.params.batchId]);
  res.json({ items: decorate(await q(pool, CART_SELECT, [req.user!.orgId])) });
}));

const checkoutSchema = z.object({
  address_id: z.string().uuid().optional(),
  delivery_address: z.string().optional(),
  distance_km: z.coerce.number().min(0).optional(),
  optional_service_codes: z.array(z.string()).default([]),
  promo_code: z.string().optional(),
  accept_auto_confirm_policy: z.literal(true, { message: 'Pelanggan wajib membaca & menyetujui kebijakan konfirmasi 24 jam' }),
  accept_weight_tolerance: z.literal(true, { message: 'Pelanggan wajib menyetujui toleransi berat aktual' }),
  items: z.array(z.object({ batch_id: z.string().uuid(), quantity: z.coerce.number().positive() })).optional(), // default: isi keranjang
});

/** Pratinjau checkout: rincian per suborder (transparan per komponen) + total. */
cartRouter.post('/checkout/preview', requireRole('BUYER'), asyncH(async (req, res) => {
  const b = parse(checkoutSchema.partial({ accept_auto_confirm_policy: true, accept_weight_tolerance: true }), req.body ?? {});
  const items = b.items?.length ? b.items : (await q(pool, 'SELECT batch_id, quantity FROM cart_items WHERE buyer_id=$1', [req.user!.orgId]));
  if (!items.length) throw bad('CART_EMPTY');
  const addr = b.address_id ? await one(pool, 'SELECT * FROM buyer_addresses WHERE id=$1 AND buyer_id=$2', [b.address_id, req.user!.orgId]) : null;
  const distance = b.distance_km ?? Number(addr?.distance_km ?? 0);
  const previews: any[] = [];
  await tx(async (c) => {
    for (const it of items) {
      const o = await createDraftOrder(c, { buyerId: req.user!.orgId!, batchId: it.batch_id, quantity: Number(it.quantity), distanceKm: distance, optionalServiceCodes: b.optional_service_codes ?? [], promoCode: b.promo_code ?? null });
      previews.push(o);
    }
    throw Object.assign(new Error('PREVIEW_ROLLBACK'), { preview: true });
  }).catch((e) => { if (!e.preview) throw e; });
  const lines = previews.map((o: any) => ({ batch_id: o.batch_id, product_id: o.product_id, supplier_id: o.supplier_id, quantity: o.quantity, unit: o.unit, unit_price: o.unit_price, product_value: o.product_value, platform_fee_amount: o.platform_fee_amount, packaging_amount: o.packaging_amount, logistics_amount: o.logistics_amount, payment_fee_amount: o.payment_fee_amount, optional_amount: o.optional_amount, discount_amount: o.discount_amount, tax_amount: o.tax_amount, total_amount: o.total_amount, trade_model: o.trade_model, pricing: o.pricing_snapshot }));
  res.json({ lines, total_amount: money(lines.reduce((s, l) => s + Number(l.total_amount), 0)), confirmation_window_hours: Number(await getSetting(pool, 'confirmation.window_hours', 24)), auto_confirm_enabled: await getSetting(pool, 'confirmation.auto_confirm_enabled', false), payment_expiry_hours: Number(await getSetting(pool, 'payment.expiry_hours', 2)) });
}));

/** CHECKOUT: order induk + suborder terkunci + reservasi stok atomik. Gagal satu item → seluruh checkout dibatalkan (tidak ada reservasi parsial). */
cartRouter.post('/checkout', requireRole('BUYER'), asyncH(async (req, res) => {
  const b = parse(checkoutSchema, req.body);
  const buyerId = req.user!.orgId!;
  const items = b.items?.length ? b.items : (await q(pool, 'SELECT batch_id, quantity FROM cart_items WHERE buyer_id=$1', [buyerId]));
  if (!items.length) throw bad('CART_EMPTY');
  const addr = b.address_id ? await maybe(pool, 'SELECT * FROM buyer_addresses WHERE id=$1 AND buyer_id=$2', [b.address_id, buyerId]) : null;
  if (b.address_id && !addr) throw forbidden();
  const address = addr ? `${addr.recipient} (${addr.phone}) — ${addr.address}${addr.city ? ', ' + addr.city : ''}${addr.province ? ', ' + addr.province : ''}` : b.delivery_address;
  if (!address) throw bad('DELIVERY_ADDRESS_REQUIRED');
  const distance = b.distance_km ?? Number(addr?.distance_km ?? 0);
  const result = await tx(async (c) => {
    const expiry = Number(await getSetting(c, 'payment.expiry_hours', 2));
    const groupNo = await nextNo(c, 'order_group', 'OG');
    const g = await one(c, `INSERT INTO order_groups(group_no, buyer_id, status, address_id, delivery_address, payment_due_at, auto_confirm_notice_accepted_at, weight_tolerance_accepted_at)
      VALUES ($1,$2,'PENDING_PAYMENT',$3,$4,now() + interval '${expiry} hours', now(), now()) RETURNING *`, [groupNo, buyerId, addr?.id ?? null, address]);
    const orders = [];
    for (const it of items) {
      const draft = await createDraftOrder(c, { buyerId, batchId: it.batch_id, quantity: Number(it.quantity), distanceKm: distance, deliveryAddress: address, optionalServiceCodes: b.optional_service_codes, promoCode: b.promo_code ?? null });
      await q(c, 'UPDATE orders SET order_group_id=$2 WHERE id=$1', [draft.id, g.id]);
      orders.push(await confirmOrder(c, draft, req.user!.id));
    }
    const total = money(orders.reduce((s, o) => s + Number(o.total_amount), 0));
    await q(c, 'UPDATE order_groups SET total_amount=$2 WHERE id=$1', [g.id, total]);
    await q(c, 'DELETE FROM cart_items WHERE buyer_id=$1 AND batch_id = ANY($2)', [buyerId, items.map((i: any) => i.batch_id)]);
    return { group: { ...g, total_amount: total }, orders };
  });
  res.status(201).json(result);
}));

cartRouter.get('/order-groups', requireRole('BUYER', 'ADMIN'), asyncH(async (req, res) => {
  const where = req.user!.role === 'BUYER' ? 'g.buyer_id=$1' : '$1::text IS NOT NULL';
  res.json(await q(pool, `SELECT g.*, (SELECT json_agg(json_build_object('id',o.id,'order_no',o.order_no,'status',o.status,'total_amount',o.total_amount,'product_name',p.name,'supplier_name',s.name) ORDER BY o.created_at)
      FROM orders o JOIN products p ON p.id=o.product_id JOIN organizations s ON s.id=o.supplier_id WHERE o.order_group_id=g.id) AS orders
    FROM order_groups g WHERE ${where} ORDER BY g.created_at DESC`, [req.user!.role === 'BUYER' ? req.user!.orgId : 'all']));
}));

cartRouter.get('/order-groups/:id', requireRole('BUYER', 'ADMIN'), asyncH(async (req, res) => {
  const g = await one(pool, 'SELECT * FROM order_groups WHERE id=$1', [req.params.id]);
  if (req.user!.role === 'BUYER' && g.buyer_id !== req.user!.orgId) throw forbidden();
  const orders = await q(pool, `SELECT o.*, p.name AS product_name, s.name AS supplier_name, b.batch_code FROM orders o JOIN products p ON p.id=o.product_id JOIN organizations s ON s.id=o.supplier_id JOIN batches b ON b.id=o.batch_id WHERE o.order_group_id=$1 ORDER BY o.created_at`, [g.id]);
  const payments = await q(pool, 'SELECT * FROM payments WHERE order_group_id=$1 ORDER BY created_at', [g.id]);
  res.json({ ...g, orders, payments });
}));

/** Bayar seluruh order induk (gateway MOCK/sandbox — ditandai is_sandbox; gateway nyata menggantikan adaptor ini). */
cartRouter.post('/order-groups/:id/pay', requireRole('BUYER'), asyncH(async (req, res) => {
  const g = await one(pool, 'SELECT * FROM order_groups WHERE id=$1', [req.params.id]);
  if (g.buyer_id !== req.user!.orgId) throw forbidden();
  if (g.status !== 'PENDING_PAYMENT') throw conflict('GROUP_NOT_PENDING_PAYMENT', { status: g.status });
  if (g.payment_due_at && new Date(g.payment_due_at) < new Date()) throw conflict('PAYMENT_EXPIRED');
  const { channel } = parse(z.object({ channel: z.string().default('VA') }), req.body ?? {});
  const result = await tx(async (c) => {
    const orders = await q(c, `SELECT * FROM orders WHERE order_group_id=$1 AND status='PENDING_PAYMENT' FOR UPDATE`, [g.id]);
    if (!orders.length) throw conflict('NO_PAYABLE_ORDERS');
    const ref = `MOCK-${Date.now()}`;
    const paid = [];
    for (const o of orders) {
      const providerFee = money(Number(o.pricing_snapshot?.costBasis?.providerFee ?? 0));
      await q(c, `INSERT INTO payments(order_id, order_group_id, provider, channel, amount, provider_fee, status, provider_ref, paid_at, is_sandbox) VALUES ($1,$2,'MOCK_GATEWAY',$3,$4,$5,'PAID',$6,now(),TRUE)`, [o.id, g.id, channel, o.total_amount, providerFee, ref]);
      const upd = await transition(c, o.id, 'PAID', req.user!.id, `Pembayaran ${ref} via ${channel} (SANDBOX, order induk ${g.group_no})`, ', paid_at=now()');
      await postBuyerPayment(c, upd, req.user!.id);
      await postProviderFee(c, upd, providerFee);
      await createAcceptanceTask(c, upd);
      paid.push(upd);
    }
    const group = await one(c, `UPDATE order_groups SET status='PAID', paid_at=now() WHERE id=$1 RETURNING *`, [g.id]);
    return { group, orders: paid, provider_ref: ref, is_sandbox: true };
  });
  res.json(result);
}));
