import { Db, q, one } from '../db';
import { conflict, money } from '../lib/http';
import { computePricing, loadPricingConfig, PricingResult } from './pricing';

export interface OrderContext {
  batch: any; supplierOrg: any; buyerOrg: any; category: { id: string; tax_class: string; trade_model?: string; reseller_markup_pct?: number };
  quantity: number; unitPrice: number; distanceKm: number; optionalServiceCodes: string[]; promoCode: string | null; at?: Date;
  platformTaxStatus?: 'PKP' | 'NON_PKP';
}

/** Model dagang hibrida: RESELLER → harga jual = harga mitra × (1 + markup), platform fee 0, penjual produk = Supplier-ID. */
export function resolveTradeModel(ctx: Pick<OrderContext, 'category' | 'batch'>, unitPrice?: number) {
  const model = ctx.category.trade_model === 'RESELLER' ? 'RESELLER' : 'MARKETPLACE';
  const purchaseUnitPrice = Number(ctx.batch.price_per_unit);
  if (model === 'RESELLER') {
    const markup = Number(ctx.category.reseller_markup_pct ?? 0);
    return { model, purchaseUnitPrice, unitPrice: money(purchaseUnitPrice * (1 + markup / 100)), markupPct: markup };
  }
  return { model, purchaseUnitPrice: null as number | null, unitPrice: unitPrice ?? purchaseUnitPrice, markupPct: 0 };
}

export async function priceOrder(db: Db, ctx: OrderContext): Promise<PricingResult & { tradeModel: string; purchaseUnitPrice: number | null; purchaseValue: number | null; resellerMargin: number }> {
  const weightKg = ctx.batch.expected_weight_kg && ctx.batch.quantity > 0
    ? money((Number(ctx.batch.expected_weight_kg) / Number(ctx.batch.quantity)) * ctx.quantity)
    : ctx.batch.unit === 'KG' ? ctx.quantity : ctx.quantity; // asumsi 1 unit ≈ 1 kg jika berat tidak dideklarasikan
  const cfg = await loadPricingConfig(db, {
    at: ctx.at, categoryId: ctx.category.id, supplierId: ctx.supplierOrg.id, buyerId: ctx.buyerOrg.id,
    promoCode: ctx.promoCode ?? undefined, region: ctx.supplierOrg.region ?? undefined, productValue: ctx.quantity * ctx.unitPrice,
  });
  const tm = resolveTradeModel(ctx, ctx.unitPrice);
  if (tm.model === 'RESELLER') cfg.platformFee = { ...cfg.platformFee, rate_percent: 0, scope_type: 'RESELLER', scope_ref: 'markup:' + tm.markupPct };
  const pr = computePricing({
    quantity: ctx.quantity, unitPrice: tm.unitPrice, weightKg, distanceKm: ctx.distanceKm,
    optionalServiceCodes: ctx.optionalServiceCodes, promoCode: ctx.promoCode,
    sellerTaxStatus: tm.model === 'RESELLER' ? (ctx.platformTaxStatus ?? 'NON_PKP') : ctx.supplierOrg.tax_status,
    buyerTaxStatus: ctx.buyerOrg.tax_status, categoryTaxClass: ctx.category.tax_class,
  }, cfg);
  const purchaseValue = tm.model === 'RESELLER' ? money(tm.purchaseUnitPrice! * ctx.quantity) : null;
  return { ...pr, tradeModel: tm.model, purchaseUnitPrice: tm.purchaseUnitPrice, purchaseValue, resellerMargin: purchaseValue != null ? money(pr.productValue - purchaseValue) : 0 };
}

export function weightOf(batch: any, quantity: number) {
  return batch.expected_weight_kg && Number(batch.quantity) > 0
    ? money((Number(batch.expected_weight_kg) / Number(batch.quantity)) * quantity)
    : quantity;
}

export const ALLOWED: Record<string, string[]> = {
  DRAFT: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'PACKING', 'CANCELLED'],
  PROCESSING: ['PACKING', 'CANCELLED'],
  PACKING: ['READY_FOR_PICKUP', 'PICKED_UP', 'CANCELLED'],
  READY_FOR_PICKUP: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT', 'ARRIVED_WAITING_INSPECTION', 'DELIVERY_FAILED'],
  IN_TRANSIT: ['ARRIVED_WAITING_INSPECTION', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['IN_TRANSIT', 'ARRIVED_WAITING_INSPECTION', 'CANCELLED'],
  ARRIVED_WAITING_INSPECTION: ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED'],
  ACCEPTED: ['SETTLED'],
  PARTIALLY_ACCEPTED: ['DISPUTED', 'SETTLED'],
  REJECTED: ['DISPUTED', 'SETTLED'],
  DISPUTED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
};

export async function transition(db: Db, orderId: string, to: string, actorId: string | null, note?: string, extraSet = '') {
  const o = await one(db, 'SELECT id, status FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!ALLOWED[o.status]?.includes(to)) throw conflict('INVALID_TRANSITION', { from: o.status, to });
  const row = await one(db, `UPDATE orders SET status=$2 ${extraSet} WHERE id=$1 RETURNING *`, [orderId, to]);
  await q(db, 'INSERT INTO order_events(order_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5)', [orderId, o.status, to, actorId, note ?? null]);
  return row;
}
