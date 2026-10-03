/**
 * RETURN FINANCIAL ADJUSTMENT — menentukan komponen REFUNDABLE / NON-REFUNDABLE / PARTIALLY REFUNDABLE
 * berdasarkan kebijakan (settings return.policy) dan atribusi penyebab hasil dispute.
 * Menghasilkan ledger entry + audit trail (financial_adjustments).
 */
import { Db, q, one } from '../db';
import { money } from '../lib/http';
import { getSetting } from './config';
import { Entry, postJournal, postRefundPaid } from './ledger';

export type Fault = 'SUPPLIER' | 'PACKAGING' | 'LOGISTICS' | 'BUYER_RECEIVING' | 'OTHER' | 'UNDETERMINED';
type Mode = 'FULL' | 'NONE' | 'PRORATA';
type Bearer = 'SUPPLIER' | 'BUYER' | 'PLATFORM' | 'LOGISTICS';

export interface AdjustmentResult {
  ratio: number;
  components: { component: string; mode: Mode; base: number; refund: number; taxReversal: number; bearer?: Bearer }[];
  refundToBuyer: number;
  supplierDeduction: number;
  platformAbsorbed: number;
  logisticsRecovery: number;
  taxReversal: number;
  returnLogistics: { cost: number; bearer: Bearer; allocation: Record<Bearer, number> };
}

export function computeAdjustment(
  order: any, approvedQty: number, fault: Fault, policy: any, returnLogisticsCost: number,
): AdjustmentResult {
  const ratio = order.quantity > 0 ? Math.min(1, approvedQty / Number(order.quantity)) : 0;
  const snap = order.pricing_snapshot ?? {};
  const taxLines: { component: string; base: number; amount: number }[] = snap.taxLines ?? [];
  const modeOf = (comp: string): Mode => (policy?.[comp]?.[fault] ?? 'NONE') as Mode;
  const apply = (mode: Mode, base: number) => (mode === 'FULL' ? base : mode === 'PRORATA' ? money(base * ratio) : 0);
  const taxFor = (comp: string, refund: number, base: number) => {
    const tl = taxLines.find((t) => t.component === comp);
    if (!tl || !tl.amount || base <= 0) return 0;
    return money((tl.amount * refund) / base);
  };

  const productBase = money(Number(order.product_value) - Number(order.discount_amount));
  const bases: { component: string; base: number }[] = [
    { component: 'PRODUCT', base: productBase },
    { component: 'PLATFORM_FEE', base: Number(order.platform_fee_amount) },
    { component: 'PACKAGING', base: Number(order.packaging_amount) },
    { component: 'LOGISTICS', base: Number(order.logistics_amount) },
    { component: 'OPTIONAL_SERVICE', base: Number(order.optional_amount) },
    { component: 'PAYMENT_FEE', base: Number(order.payment_fee_amount) },
  ];
  const components: AdjustmentResult['components'] = bases.map((b) => {
    const mode = modeOf(b.component);
    const refund = apply(mode, b.base);
    return { component: b.component, mode, base: b.base, refund, taxReversal: taxFor(b.component, refund, b.base) };
  });
  const productLossBearer: Bearer = (policy?.product_loss_bearer?.[fault] ?? 'PLATFORM') as Bearer;
  const prod = components.find((c) => c.component === 'PRODUCT')!;
  prod.bearer = productLossBearer;

  const taxReversal = money(components.reduce((a, c) => a + c.taxReversal, 0));
  const refundToBuyer = money(components.reduce((a, c) => a + c.refund, 0) + taxReversal);

  const rlBearer: Bearer = (policy?.return_logistics_bearer?.[fault] ?? 'PLATFORM') as Bearer;
  const allocation: Record<Bearer, number> = { SUPPLIER: 0, BUYER: 0, PLATFORM: 0, LOGISTICS: 0 };
  let rlCost = money(returnLogisticsCost);
  if (rlBearer === 'BUYER') {
    // buyer menanggung: dipotong dari refund; sisa (jika refund kurang) ditanggung platform
    const fromRefund = Math.min(rlCost, refundToBuyer);
    allocation.BUYER = money(fromRefund);
    allocation.PLATFORM = money(rlCost - fromRefund);
  } else {
    allocation[rlBearer] = rlCost;
  }

  const supplierDeduction = money((productLossBearer === 'SUPPLIER' ? prod.refund : 0) + allocation.SUPPLIER);
  const logisticsRecovery = money(productLossBearer === 'LOGISTICS' ? prod.refund : 0);
  const platformAbsorbed = money((productLossBearer === 'PLATFORM' ? prod.refund : 0) + allocation.PLATFORM);

  return {
    ratio, components, refundToBuyer, supplierDeduction, platformAbsorbed, logisticsRecovery, taxReversal,
    returnLogistics: { cost: rlCost, bearer: rlBearer, allocation },
  };
}

/** Buat jurnal adjustment + catatan financial_adjustments, lalu bayar refund (mock gateway) → kas keluar. */
export async function applyReturnAdjustment(db: Db, orderId: string, returnCaseId: string, approvedQty: number, fault: Fault, userId: string | null) {
  const order = await one(db, 'SELECT * FROM orders WHERE id=$1', [orderId]);
  const rc = await one(db, 'SELECT * FROM return_cases WHERE id=$1', [returnCaseId]);
  const policy = await getSetting(db, 'return.policy');
  const adj = computeAdjustment(order, approvedQty, fault, policy, Number(rc.return_logistics_cost));

  const entries: Entry[] = [];
  const S = order.supplier_id, B = order.buyer_id;
  const acctOf: Record<string, Entry['account']> = {
    PLATFORM_FEE: 'PLATFORM_FEE_REVENUE', PACKAGING: 'PACKAGING_REVENUE', LOGISTICS: 'LOGISTICS_REVENUE',
    OPTIONAL_SERVICE: 'OPTIONAL_SERVICE_REVENUE', PAYMENT_FEE: 'PAYMENT_FEE_COLLECTED',
  };
  const compOf: Record<string, Entry['component']> = {
    PLATFORM_FEE: 'PLATFORM_FEE_REVENUE', PACKAGING: 'PACKAGING_REVENUE', LOGISTICS: 'LOGISTICS_REVENUE',
    OPTIONAL_SERVICE: 'OPTIONAL_SERVICE', PAYMENT_FEE: 'PAYMENT_FEE',
  };
  for (const c of adj.components) {
    if (c.refund <= 0) continue;
    if (c.component === 'PRODUCT') {
      if (c.bearer === 'SUPPLIER' && order.trade_model === 'RESELLER' && Number(order.purchase_value) > 0) {
        // RESELLER: hak mitra dipotong proporsional harga beli; sisa refund membalik margin Supplier-ID
        const supplierPart = money(c.refund * (Number(order.purchase_value) / Number(order.product_value)));
        entries.push({ account: 'SUPPLIER_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: supplierPart, partyType: 'SUPPLIER', partyId: S, memo: 'Potongan hak mitra (harga beli) atas barang ditolak' });
        entries.push({ account: 'RESELLER_MARGIN_REVENUE', component: 'RESELLER_MARGIN', side: 'DEBIT', amount: money(c.refund - supplierPart), partyType: 'PLATFORM', memo: 'Pembalikan margin reseller atas barang ditolak' });
      } else if (c.bearer === 'SUPPLIER') entries.push({ account: 'SUPPLIER_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: c.refund, partyType: 'SUPPLIER', partyId: S, memo: 'Potongan hak supplier atas barang ditolak' });
      else if (c.bearer === 'LOGISTICS') entries.push({ account: 'LOGISTICS_RECEIVABLE', component: 'LOGISTICS_RECOVERY', side: 'DEBIT', amount: c.refund, partyType: 'PLATFORM', memo: 'Piutang klaim ke penyedia logistik' });
      else entries.push({ account: 'RETURN_ADJUSTMENT', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: c.refund, partyType: 'PLATFORM', memo: 'Kerugian retur ditanggung platform' });
    } else {
      entries.push({ account: acctOf[c.component], component: compOf[c.component], side: 'DEBIT', amount: c.refund, partyType: 'PLATFORM', memo: `Refund komponen ${c.component}` });
    }
  }
  if (adj.taxReversal > 0) entries.push({ account: 'TAX_PAYABLE', component: 'TAX_PAYABLE', side: 'DEBIT', amount: adj.taxReversal, partyType: 'PLATFORM', memo: 'Pembalikan pajak atas refund' });
  if (adj.refundToBuyer > 0) entries.push({ account: 'REFUND_PAYABLE', component: 'REFUND', side: 'CREDIT', amount: adj.refundToBuyer, partyType: 'BUYER', partyId: B, memo: 'Refund terutang ke buyer' });

  // biaya return logistics
  const a = adj.returnLogistics.allocation;
  const rlPayable = money(a.SUPPLIER + a.BUYER + a.PLATFORM); // LOGISTICS menanggung sendiri → tidak ada kewajiban platform
  if (a.SUPPLIER > 0) entries.push({ account: 'SUPPLIER_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: a.SUPPLIER, partyType: 'SUPPLIER', partyId: S, memo: 'Biaya return logistics dibebankan ke supplier' });
  if (a.BUYER > 0) entries.push({ account: 'REFUND_PAYABLE', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: a.BUYER, partyType: 'BUYER', partyId: B, memo: 'Biaya return logistics dipotong dari refund buyer' });
  if (a.PLATFORM > 0) entries.push({ account: 'RETURN_ADJUSTMENT', component: 'RETURN_ADJUSTMENT', side: 'DEBIT', amount: a.PLATFORM, partyType: 'PLATFORM', memo: 'Biaya return logistics ditanggung platform' });
  if (rlPayable > 0) entries.push({ account: 'LOGISTICS_PAYABLE', component: 'LOGISTICS_PAYABLE', side: 'CREDIT', amount: rlPayable, partyType: 'PLATFORM', memo: 'Utang ke penyedia logistik (return pickup)' });

  let journalId: string | null = null;
  if (entries.length) {
    journalId = await postJournal(db, { type: 'RETURN_ADJUSTMENT', orderId, returnCaseId, reference: rc.case_no, createdBy: userId, memo: `Atribusi: ${fault}` }, entries);
  }
  const fa = await one(
    db,
    `INSERT INTO financial_adjustments(order_id, return_case_id, adjustment_type, fault_attribution, components, refund_to_buyer,
       supplier_deduction, platform_absorbed, logistics_recovery, tax_reversal, journal_id, created_by)
     VALUES ($1,$2,'RETURN_REFUND',$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [orderId, returnCaseId, fault, JSON.stringify({ ratio: adj.ratio, components: adj.components, returnLogistics: adj.returnLogistics }),
      adj.refundToBuyer, adj.supplierDeduction, adj.platformAbsorbed, adj.logisticsRecovery, adj.taxReversal, journalId, userId],
  );
  await q(db, 'UPDATE return_cases SET cost_allocation=$2::jsonb WHERE id=$1', [returnCaseId, JSON.stringify(adj.returnLogistics.allocation)]);

  // Refund dibayarkan (mock gateway: instan) — net setelah potongan biaya yang ditanggung buyer
  const netRefund = money(adj.refundToBuyer - a.BUYER);
  if (netRefund > 0) {
    await postRefundPaid(db, order, netRefund, returnCaseId);
    const pay = await one(db, 'SELECT * FROM payments WHERE order_id=$1 AND status IN (\'PAID\',\'PARTIALLY_REFUNDED\') ORDER BY created_at DESC LIMIT 1', [orderId]);
    const full = Math.abs(netRefund - Number(pay.amount)) < 0.005;
    await q(db, 'UPDATE payments SET status=$2 WHERE id=$1', [pay.id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED']);
  }
  return { adjustment: fa, computed: adj, netRefund };
}
