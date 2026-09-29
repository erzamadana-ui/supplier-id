/**
 * PRICING ENGINE — memisahkan PRODUCT VALUE, PLATFORM FEE, PACKAGING, LOGISTICS,
 * PAYMENT FEE, TAX, OPTIONAL SERVICES, DISCOUNT dan FINAL AMOUNT.
 * Fungsi murni (computePricing) agar bisa diuji unit; buildPricing memuat konfigurasi dari DB.
 */
import { Db } from '../db';
import { money } from '../lib/http';
import { getSetting, loadTaxRules, resolvePlatformFee, TaxRule, FeeContext } from './config';

export type Component = 'PRODUCT' | 'PLATFORM_FEE' | 'PACKAGING' | 'LOGISTICS' | 'PAYMENT_FEE' | 'OPTIONAL_SERVICE';

export interface PricingConfig {
  platformFee: { id: string; rate_percent: number; scope_type: string; scope_ref: string | null; effective_from: string };
  packagingRatePerKg: number;
  packagingCostRatio: number;
  logistics: { base: number; perKm: number; perKg: number; costRatio: number };
  payment: { feePercent: number; feeFixed: number; providerFeePercent: number; providerFeeFixed: number };
  taxRules: TaxRule[];
  optionalServices: { code: string; label: string; mode: 'PERCENT_OF_PRODUCT' | 'PER_KG' | 'FIXED'; value: number }[];
  promotions: { code: string; label: string; mode: 'PERCENT_OF_PRODUCT' | 'FIXED'; value: number; max?: number; active: boolean }[];
}

export interface PricingInput {
  quantity: number;
  unitPrice: number;
  weightKg: number;
  distanceKm: number;
  optionalServiceCodes?: string[];
  promoCode?: string | null;
  sellerTaxStatus: 'PKP' | 'NON_PKP';
  buyerTaxStatus: 'PKP' | 'NON_PKP';
  categoryTaxClass: string;       // STANDARD | BASIC_NEEDS_EXEMPT
  transactionType?: string;       // MARKETPLACE | CONTRACT
}

export interface TaxLine { component: Component; rule: string; base: number; dpp: number; rate: number; amount: number; taxable: boolean }

export interface PricingResult {
  productValue: number;
  platformFeeRate: number;
  platformFeeAmount: number;
  packagingAmount: number;
  logisticsAmount: number;
  paymentFeeAmount: number;
  optionalAmount: number;
  optionalLines: { code: string; label: string; amount: number }[];
  discountAmount: number;
  discountLine: { code: string; label: string } | null;
  subtotalBeforeTax: number;
  taxAmount: number;
  taxLines: TaxLine[];
  totalAmount: number;
  // basis biaya (internal, bukan tagihan buyer)
  costBasis: { packagingCost: number; logisticsCost: number; providerFee: number };
  feeConfig: PricingConfig['platformFee'];
}

export function pickTaxRule(rules: TaxRule[], component: Component, ctx: { sellerStatus: string; buyerStatus: string; serviceType: string; transactionType: string }) {
  const m = (ruleVal: string, actual: string) => ruleVal === 'ANY' || ruleVal === actual;
  return rules
    .filter((r) => r.component === component)
    .filter((r) => m(r.seller_status, ctx.sellerStatus) && m(r.buyer_status, ctx.buyerStatus) && m(r.service_type, ctx.serviceType) && m(r.transaction_type, ctx.transactionType))
    .sort((a, b) => a.priority - b.priority)[0] ?? null;
}

export function computePricing(input: PricingInput, cfg: PricingConfig): PricingResult {
  const productValue = money(input.quantity * input.unitPrice);
  const rate = cfg.platformFee.rate_percent;
  const platformFeeAmount = money((productValue * rate) / 100);
  const packagingAmount = money(input.weightKg * cfg.packagingRatePerKg);
  const logisticsAmount = money(cfg.logistics.base + cfg.logistics.perKm * input.distanceKm + cfg.logistics.perKg * input.weightKg);

  const optionalLines = (input.optionalServiceCodes ?? [])
    .map((code) => cfg.optionalServices.find((s) => s.code === code))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({
      code: s.code,
      label: s.label,
      amount: money(s.mode === 'PERCENT_OF_PRODUCT' ? (productValue * s.value) / 100 : s.mode === 'PER_KG' ? input.weightKg * s.value : s.value),
    }));
  const optionalAmount = money(optionalLines.reduce((a, l) => a + l.amount, 0));

  let discountAmount = 0;
  let discountLine: PricingResult['discountLine'] = null;
  if (input.promoCode) {
    const p = cfg.promotions.find((x) => x.code === input.promoCode && x.active);
    if (p) {
      discountAmount = p.mode === 'PERCENT_OF_PRODUCT' ? (productValue * p.value) / 100 : p.value;
      if (p.max != null) discountAmount = Math.min(discountAmount, p.max);
      discountAmount = money(Math.min(discountAmount, productValue));
      discountLine = { code: p.code, label: p.label };
    }
  }

  // PAJAK per komponen — tidak diasumsikan sama untuk semua komponen.
  // Diskon mengurangi dasar pengenaan pajak produk (DPP).
  const ctx = {
    buyerStatus: input.buyerTaxStatus,
    transactionType: input.transactionType ?? 'MARKETPLACE',
  };
  const bases: { component: Component; base: number; sellerStatus: string; serviceType: string }[] = [
    { component: 'PRODUCT', base: productValue - discountAmount, sellerStatus: input.sellerTaxStatus, serviceType: input.categoryTaxClass },
    { component: 'PLATFORM_FEE', base: platformFeeAmount, sellerStatus: 'PKP', serviceType: 'PLATFORM_SERVICE' },
    { component: 'PACKAGING', base: packagingAmount, sellerStatus: 'PKP', serviceType: 'PACKAGING' },
    { component: 'LOGISTICS', base: logisticsAmount, sellerStatus: 'PKP', serviceType: 'LOGISTICS' },
    { component: 'OPTIONAL_SERVICE', base: optionalAmount, sellerStatus: 'PKP', serviceType: 'OPTIONAL' },
  ];
  const taxLines: TaxLine[] = [];
  for (const b of bases) {
    const rule = pickTaxRule(cfg.taxRules, b.component, { ...ctx, sellerStatus: b.sellerStatus, serviceType: b.serviceType });
    if (!rule || !rule.taxable || b.base <= 0) {
      taxLines.push({ component: b.component, rule: rule?.name ?? 'NO_RULE', base: b.base, dpp: 0, rate: 0, amount: 0, taxable: false });
      continue;
    }
    const dpp = money(b.base * rule.dpp_factor);
    const amount = money((dpp * rule.rate_percent) / 100);
    taxLines.push({ component: b.component, rule: rule.name, base: b.base, dpp, rate: rule.rate_percent, amount, taxable: true });
  }
  const taxAmount = money(taxLines.reduce((a, l) => a + l.amount, 0));

  // PAYMENT FEE dihitung dari nilai yang akan dibayar (sebelum payment fee sendiri)
  const payableBeforePaymentFee = money(productValue + platformFeeAmount + packagingAmount + logisticsAmount + optionalAmount - discountAmount + taxAmount);
  const paymentFeeAmount = money((payableBeforePaymentFee * cfg.payment.feePercent) / 100 + cfg.payment.feeFixed);
  const pfRule = pickTaxRule(cfg.taxRules, 'PAYMENT_FEE', { ...ctx, sellerStatus: 'PKP', serviceType: 'PAYMENT' });
  let pfTax = 0;
  if (pfRule?.taxable && paymentFeeAmount > 0) {
    pfTax = money((money(paymentFeeAmount * pfRule.dpp_factor) * pfRule.rate_percent) / 100);
    taxLines.push({ component: 'PAYMENT_FEE', rule: pfRule.name, base: paymentFeeAmount, dpp: money(paymentFeeAmount * pfRule.dpp_factor), rate: pfRule.rate_percent, amount: pfTax, taxable: true });
  } else {
    taxLines.push({ component: 'PAYMENT_FEE', rule: pfRule?.name ?? 'NO_RULE', base: paymentFeeAmount, dpp: 0, rate: 0, amount: 0, taxable: false });
  }
  const totalTax = money(taxAmount + pfTax);
  const subtotalBeforeTax = money(productValue + platformFeeAmount + packagingAmount + logisticsAmount + optionalAmount + paymentFeeAmount - discountAmount);
  const totalAmount = money(subtotalBeforeTax + totalTax);

  const costBasis = {
    packagingCost: money(packagingAmount * cfg.packagingCostRatio),
    logisticsCost: money(logisticsAmount * cfg.logistics.costRatio),
    providerFee: money((totalAmount * cfg.payment.providerFeePercent) / 100 + cfg.payment.providerFeeFixed),
  };

  return {
    productValue, platformFeeRate: rate, platformFeeAmount, packagingAmount, logisticsAmount, paymentFeeAmount,
    optionalAmount, optionalLines, discountAmount, discountLine, subtotalBeforeTax, taxAmount: totalTax, taxLines,
    totalAmount, costBasis, feeConfig: cfg.platformFee,
  };
}

export async function loadPricingConfig(db: Db, feeCtx: FeeContext): Promise<PricingConfig> {
  const [platformFee, taxRules] = await Promise.all([resolvePlatformFee(db, feeCtx), loadTaxRules(db, feeCtx.at ?? new Date())]);
  const s = async <T,>(k: string, d: T) => getSetting<T>(db, k, d);
  return {
    platformFee,
    packagingRatePerKg: Number(await s('packaging.rate_per_kg', 250)),
    packagingCostRatio: Number(await s('packaging.cost_ratio', 0.8)),
    logistics: {
      base: Number(await s('logistics.base_fee', 150000)),
      perKm: Number(await s('logistics.rate_per_km', 3500)),
      perKg: Number(await s('logistics.rate_per_kg', 350)),
      costRatio: Number(await s('logistics.cost_ratio', 0.85)),
    },
    payment: {
      feePercent: Number(await s('payment.fee_percent', 1)),
      feeFixed: Number(await s('payment.fee_fixed', 0)),
      providerFeePercent: Number(await s('payment.provider_fee_percent', 1)),
      providerFeeFixed: Number(await s('payment.provider_fee_fixed', 0)),
    },
    taxRules,
    optionalServices: await s('optional_services', []),
    promotions: await s('promotions', []),
  };
}
