import { Db, q, one } from '../db';
import { conflict, money } from '../lib/http';
import { computePricing, loadPricingConfig, PricingResult } from './pricing';

export interface OrderContext {
  batch: any; supplierOrg: any; buyerOrg: any; category: { id: string; tax_class: string };
  quantity: number; unitPrice: number; distanceKm: number; optionalServiceCodes: string[]; promoCode: string | null; at?: Date;
}

export async function priceOrder(db: Db, ctx: OrderContext): Promise<PricingResult> {
  const weightKg = ctx.batch.expected_weight_kg && ctx.batch.quantity > 0
    ? money((Number(ctx.batch.expected_weight_kg) / Number(ctx.batch.quantity)) * ctx.quantity)
    : ctx.batch.unit === 'KG' ? ctx.quantity : ctx.quantity; // asumsi 1 unit ≈ 1 kg jika berat tidak dideklarasikan
  const cfg = await loadPricingConfig(db, {
    at: ctx.at, categoryId: ctx.category.id, supplierId: ctx.supplierOrg.id, buyerId: ctx.buyerOrg.id,
    promoCode: ctx.promoCode ?? undefined, region: ctx.supplierOrg.region ?? undefined, productValue: ctx.quantity * ctx.unitPrice,
  });
  return computePricing({
    quantity: ctx.quantity, unitPrice: ctx.unitPrice, weightKg, distanceKm: ctx.distanceKm,
    optionalServiceCodes: ctx.optionalServiceCodes, promoCode: ctx.promoCode,
    sellerTaxStatus: ctx.supplierOrg.tax_status, buyerTaxStatus: ctx.buyerOrg.tax_status, categoryTaxClass: ctx.category.tax_class,
  }, cfg);
}

export function weightOf(batch: any, quantity: number) {
  return batch.expected_weight_kg && Number(batch.quantity) > 0
    ? money((Number(batch.expected_weight_kg) / Number(batch.quantity)) * quantity)
    : quantity;
}

export const ALLOWED: Record<string, string[]> = {
  DRAFT: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PACKING', 'CANCELLED'],
  PACKING: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT', 'ARRIVED_WAITING_INSPECTION'],
  IN_TRANSIT: ['ARRIVED_WAITING_INSPECTION'],
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
