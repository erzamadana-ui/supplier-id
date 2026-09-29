import { describe, it, expect } from 'vitest';
import { computeAdjustment } from '../../src/services/adjustment';

const policy = {
  PRODUCT: { SUPPLIER: 'PRORATA', PACKAGING: 'PRORATA', LOGISTICS: 'PRORATA', BUYER_RECEIVING: 'NONE', OTHER: 'PRORATA', UNDETERMINED: 'PRORATA' },
  PLATFORM_FEE: { SUPPLIER: 'PRORATA', PACKAGING: 'PRORATA', LOGISTICS: 'PRORATA', BUYER_RECEIVING: 'NONE', OTHER: 'PRORATA', UNDETERMINED: 'PRORATA' },
  PACKAGING: { SUPPLIER: 'PRORATA', PACKAGING: 'PRORATA', LOGISTICS: 'NONE', BUYER_RECEIVING: 'NONE', OTHER: 'NONE', UNDETERMINED: 'NONE' },
  LOGISTICS: { SUPPLIER: 'NONE', PACKAGING: 'NONE', LOGISTICS: 'PRORATA', BUYER_RECEIVING: 'NONE', OTHER: 'NONE', UNDETERMINED: 'NONE' },
  OPTIONAL_SERVICE: { SUPPLIER: 'NONE', PACKAGING: 'NONE', LOGISTICS: 'NONE', BUYER_RECEIVING: 'NONE', OTHER: 'NONE', UNDETERMINED: 'NONE' },
  PAYMENT_FEE: { SUPPLIER: 'NONE', PACKAGING: 'NONE', LOGISTICS: 'NONE', BUYER_RECEIVING: 'NONE', OTHER: 'NONE', UNDETERMINED: 'NONE' },
  product_loss_bearer: { SUPPLIER: 'SUPPLIER', PACKAGING: 'SUPPLIER', LOGISTICS: 'LOGISTICS', BUYER_RECEIVING: 'BUYER', OTHER: 'PLATFORM', UNDETERMINED: 'PLATFORM' },
  return_logistics_bearer: { SUPPLIER: 'SUPPLIER', PACKAGING: 'SUPPLIER', LOGISTICS: 'LOGISTICS', BUYER_RECEIVING: 'BUYER', OTHER: 'PLATFORM', UNDETERMINED: 'PLATFORM' },
};

// order 1.000 kg: produk 10jt, fee 1,5jt, packaging 250rb, logistik 500rb, payment fee 100rb, PPN jasa 247.500
const order = {
  quantity: 1000, product_value: 10_000_000, discount_amount: 0, platform_fee_amount: 1_500_000, packaging_amount: 250_000,
  logistics_amount: 500_000, optional_amount: 0, payment_fee_amount: 100_000, tax_amount: 247_500,
  pricing_snapshot: { taxLines: [
    { component: 'PRODUCT', base: 10_000_000, amount: 0 }, { component: 'PLATFORM_FEE', base: 1_500_000, amount: 165_000 },
    { component: 'PACKAGING', base: 250_000, amount: 27_500 }, { component: 'LOGISTICS', base: 500_000, amount: 55_000 }, { component: 'PAYMENT_FEE', base: 100_000, amount: 0 },
  ] },
};

describe('Return financial adjustment', () => {
  it('partial return 80 dari 1.000 kg, kesalahan SUPPLIER: refund prorata produk+fee+packaging, supplier menanggung produk & return logistics', () => {
    const a = computeAdjustment(order, 80, 'SUPPLIER', policy, 40_000);
    expect(a.ratio).toBe(0.08);
    const c = Object.fromEntries(a.components.map((x) => [x.component, x]));
    expect(c.PRODUCT.refund).toBe(800_000);
    expect(c.PLATFORM_FEE.refund).toBe(120_000);
    expect(c.PACKAGING.refund).toBe(20_000);
    expect(c.LOGISTICS.refund).toBe(0);
    expect(c.PAYMENT_FEE.refund).toBe(0);
    expect(a.taxReversal).toBe(13_200 + 2_200); // 8% dari PPN fee (165.000) + PPN packaging (27.500)
    expect(a.refundToBuyer).toBe(800_000 + 120_000 + 20_000 + 15_400);
    expect(a.supplierDeduction).toBe(800_000 + 40_000);
    expect(a.returnLogistics.allocation.SUPPLIER).toBe(40_000);
    expect(a.platformAbsorbed).toBe(0);
  });

  it('kesalahan LOGISTICS: supplier tidak dipotong; produk & logistik direfund; platform klaim ke penyedia logistik', () => {
    const a = computeAdjustment(order, 1000, 'LOGISTICS', policy, 250_000);
    const c = Object.fromEntries(a.components.map((x) => [x.component, x]));
    expect(c.PRODUCT.refund).toBe(10_000_000);
    expect(c.LOGISTICS.refund).toBe(500_000);
    expect(c.PACKAGING.refund).toBe(0);
    expect(a.supplierDeduction).toBe(0);
    expect(a.logisticsRecovery).toBe(10_000_000);
    expect(a.returnLogistics.allocation.LOGISTICS).toBe(250_000);
  });

  it('kesalahan BUYER_RECEIVING: tidak ada refund, biaya return logistics dibebankan ke buyer (dibatasi refund) sisanya platform', () => {
    const a = computeAdjustment(order, 100, 'BUYER_RECEIVING', policy, 50_000);
    expect(a.refundToBuyer).toBe(0);
    expect(a.returnLogistics.allocation.BUYER).toBe(0);
    expect(a.returnLogistics.allocation.PLATFORM).toBe(50_000);
    expect(a.supplierDeduction).toBe(0);
  });

  it('UNDETERMINED: platform menanggung kerugian produk dan return logistics', () => {
    const a = computeAdjustment(order, 500, 'UNDETERMINED', policy, 100_000);
    expect(a.platformAbsorbed).toBe(5_000_000 + 100_000);
    expect(a.supplierDeduction).toBe(0);
  });
});
