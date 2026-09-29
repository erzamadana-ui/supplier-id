import { describe, it, expect } from 'vitest';
import { computePricing, PricingConfig } from '../../src/services/pricing';

const taxRules: PricingConfig['taxRules'] = [
  { id: '1', name: 'PPN produk PKP standar', component: 'PRODUCT', transaction_type: 'ANY', seller_status: 'PKP', buyer_status: 'ANY', service_type: 'STANDARD', taxable: true, rate_percent: 11, dpp_factor: 1, priority: 10 },
  { id: '2', name: 'Produk kebutuhan pokok dibebaskan', component: 'PRODUCT', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'BASIC_NEEDS_EXEMPT', taxable: false, rate_percent: 0, dpp_factor: 1, priority: 5 },
  { id: '3', name: 'Non-PKP tidak memungut', component: 'PRODUCT', transaction_type: 'ANY', seller_status: 'NON_PKP', buyer_status: 'ANY', service_type: 'ANY', taxable: false, rate_percent: 0, dpp_factor: 1, priority: 20 },
  { id: '4', name: 'PPN platform fee', component: 'PLATFORM_FEE', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'ANY', taxable: true, rate_percent: 11, dpp_factor: 1, priority: 50 },
  { id: '5', name: 'PPN packaging', component: 'PACKAGING', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'ANY', taxable: true, rate_percent: 11, dpp_factor: 1, priority: 50 },
  { id: '6', name: 'PPN logistik', component: 'LOGISTICS', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'ANY', taxable: true, rate_percent: 11, dpp_factor: 1, priority: 50 },
  { id: '7', name: 'Payment fee pass-through', component: 'PAYMENT_FEE', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'ANY', taxable: false, rate_percent: 0, dpp_factor: 1, priority: 50 },
  { id: '8', name: 'PPN opsional', component: 'OPTIONAL_SERVICE', transaction_type: 'ANY', seller_status: 'ANY', buyer_status: 'ANY', service_type: 'ANY', taxable: true, rate_percent: 11, dpp_factor: 1, priority: 50 },
];

const cfg = (over: Partial<PricingConfig> = {}): PricingConfig => ({
  platformFee: { id: 'fee-1', rate_percent: 15, scope_type: 'GLOBAL', scope_ref: null, effective_from: '2026-01-01' },
  packagingRatePerKg: 250,
  packagingCostRatio: 0.8,
  logistics: { base: 150000, perKm: 3500, perKg: 350, costRatio: 0.85 },
  payment: { feePercent: 0, feeFixed: 100000, providerFeePercent: 1, providerFeeFixed: 0 },
  taxRules,
  optionalServices: [{ code: 'COLD_CHAIN', label: 'Cold chain', mode: 'PER_KG', value: 500 }],
  promotions: [{ code: 'HEMAT5', label: '5%', mode: 'PERCENT_OF_PRODUCT', value: 5, max: 500000, active: true }],
  ...over,
});

describe('Pricing engine', () => {
  it('memisahkan product value, platform fee 15%, packaging, logistics, payment fee, pajak, total (contoh spesifikasi)', () => {
    // 1.000 kg × Rp10.000 = Rp10.000.000; packaging 1.000 kg × 250 = 250.000; logistik 150.000 + 350×1.000 = 500.000; payment fee tetap 100.000
    const r = computePricing({ quantity: 1000, unitPrice: 10000, weightKg: 1000, distanceKm: 0, sellerTaxStatus: 'NON_PKP', buyerTaxStatus: 'PKP', categoryTaxClass: 'BASIC_NEEDS_EXEMPT' }, cfg());
    expect(r.productValue).toBe(10_000_000);
    expect(r.platformFeeRate).toBe(15);
    expect(r.platformFeeAmount).toBe(1_500_000);
    expect(r.packagingAmount).toBe(250_000);
    expect(r.logisticsAmount).toBe(500_000);
    expect(r.paymentFeeAmount).toBe(100_000);
    // PPN hanya pada jasa platform (fee, packaging, logistik) = 11% × 2.250.000 = 247.500; produk dibebaskan (kebutuhan pokok, non-PKP)
    expect(r.taxAmount).toBe(247_500);
    expect(r.taxLines.find((t) => t.component === 'PRODUCT')!.taxable).toBe(false);
    expect(r.taxLines.find((t) => t.component === 'PAYMENT_FEE')!.taxable).toBe(false);
    expect(r.totalAmount).toBe(10_000_000 + 1_500_000 + 250_000 + 500_000 + 100_000 + 247_500);
    // total = penjumlahan seluruh komponen (tanpa hidden charge)
    expect(r.totalAmount).toBe(r.productValue + r.platformFeeAmount + r.packagingAmount + r.logisticsAmount + r.paymentFeeAmount + r.optionalAmount - r.discountAmount + r.taxAmount);
  });

  it('platform fee mengikuti rate konfigurasi (bukan hard-code): 12% → Rp1.200.000', () => {
    const r = computePricing({ quantity: 1000, unitPrice: 10000, weightKg: 1000, distanceKm: 0, sellerTaxStatus: 'NON_PKP', buyerTaxStatus: 'PKP', categoryTaxClass: 'BASIC_NEEDS_EXEMPT' },
      cfg({ platformFee: { id: 'fee-2', rate_percent: 12, scope_type: 'GLOBAL', scope_ref: null, effective_from: '2026-06-01' } }));
    expect(r.platformFeeAmount).toBe(1_200_000);
  });

  it('pajak tidak diasumsikan sama untuk semua komponen: produk supplier PKP kategori standar kena PPN, non-PKP tidak', () => {
    const base = { quantity: 100, unitPrice: 100000, weightKg: 100, distanceKm: 10, buyerTaxStatus: 'PKP' as const, categoryTaxClass: 'STANDARD' };
    const pkp = computePricing({ ...base, sellerTaxStatus: 'PKP' }, cfg());
    const non = computePricing({ ...base, sellerTaxStatus: 'NON_PKP' }, cfg());
    expect(pkp.taxLines.find((t) => t.component === 'PRODUCT')!.amount).toBe(1_100_000); // 11% × 10.000.000
    expect(non.taxLines.find((t) => t.component === 'PRODUCT')!.amount).toBe(0);
    expect(pkp.totalAmount - non.totalAmount).toBe(1_100_000);
  });

  it('dpp_factor dikonfigurasi (mis. 11/12) memengaruhi dasar pengenaan pajak', () => {
    const rules = taxRules.map((r) => (r.component === 'PLATFORM_FEE' ? { ...r, rate_percent: 12, dpp_factor: 11 / 12 } : r));
    const r = computePricing({ quantity: 1000, unitPrice: 10000, weightKg: 1000, distanceKm: 0, sellerTaxStatus: 'NON_PKP', buyerTaxStatus: 'PKP', categoryTaxClass: 'BASIC_NEEDS_EXEMPT' }, cfg({ taxRules: rules }));
    const t = r.taxLines.find((t) => t.component === 'PLATFORM_FEE')!;
    expect(t.dpp).toBe(1_375_000);
    expect(t.amount).toBe(165_000); // 12% × 1.375.000 = sama dengan 11% × 1.500.000
  });

  it('diskon promo mengurangi total dan DPP produk; layanan opsional dihitung terpisah', () => {
    const r = computePricing({ quantity: 1000, unitPrice: 10000, weightKg: 1000, distanceKm: 0, sellerTaxStatus: 'PKP', buyerTaxStatus: 'PKP', categoryTaxClass: 'STANDARD', promoCode: 'HEMAT5', optionalServiceCodes: ['COLD_CHAIN'] }, cfg());
    expect(r.discountAmount).toBe(500_000); // 5% = 500.000 (maks 500.000)
    expect(r.optionalAmount).toBe(500_000); // 1.000 kg × 500
    expect(r.taxLines.find((t) => t.component === 'PRODUCT')!.base).toBe(9_500_000);
    expect(r.taxLines.find((t) => t.component === 'PRODUCT')!.amount).toBe(1_045_000);
    expect(r.optionalLines[0].code).toBe('COLD_CHAIN');
  });

  it('payment fee persentase dihitung dari nilai yang dibayar (termasuk pajak) dan biaya provider dipisahkan sebagai cost basis', () => {
    const r = computePricing({ quantity: 10, unitPrice: 100000, weightKg: 10, distanceKm: 0, sellerTaxStatus: 'NON_PKP', buyerTaxStatus: 'NON_PKP', categoryTaxClass: 'BASIC_NEEDS_EXEMPT' },
      cfg({ payment: { feePercent: 1, feeFixed: 0, providerFeePercent: 0.7, providerFeeFixed: 4000 } }));
    const before = r.productValue + r.platformFeeAmount + r.packagingAmount + r.logisticsAmount + r.taxAmount;
    expect(r.paymentFeeAmount).toBe(Math.round(before * 0.01 * 100) / 100);
    expect(r.costBasis.providerFee).toBe(Math.round((r.totalAmount * 0.007 + 4000) * 100) / 100);
    expect(r.costBasis.packagingCost).toBe(r.packagingAmount * 0.8);
  });
});
