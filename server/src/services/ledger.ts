/**
 * LEDGER — pencatatan double-entry. Setiap jurnal harus seimbang (Σ debit = Σ kredit).
 * account  = akun akuntansi;  component = lini bisnis (PRODUCT_VALUE, PLATFORM_FEE_REVENUE, ...) untuk pelaporan.
 */
import { Db, q, one } from '../db';
import { bad, money } from '../lib/http';

export type Account =
  | 'CASH' | 'SUPPLIER_PAYABLE' | 'REFUND_PAYABLE' | 'LOGISTICS_PAYABLE' | 'TAX_PAYABLE'
  | 'PLATFORM_FEE_REVENUE' | 'PACKAGING_REVENUE' | 'LOGISTICS_REVENUE' | 'OPTIONAL_SERVICE_REVENUE' | 'PAYMENT_FEE_COLLECTED'
  | 'PACKAGING_COST' | 'LOGISTICS_COST' | 'PAYMENT_PROCESSING_FEE' | 'PROMOTION_DISCOUNT' | 'RETURN_ADJUSTMENT' | 'LOGISTICS_RECEIVABLE';
export type LComponent =
  | 'PRODUCT_VALUE' | 'PLATFORM_FEE_REVENUE' | 'PACKAGING_REVENUE' | 'PACKAGING_COST' | 'LOGISTICS_REVENUE' | 'LOGISTICS_PAYABLE'
  | 'PAYMENT_PROCESSING_FEE' | 'TAX_PAYABLE' | 'REFUND' | 'RETURN_ADJUSTMENT' | 'SUPPLIER_PAYABLE' | 'SUPPLIER_PAYOUT'
  | 'PROMOTION_DISCOUNT' | 'OPTIONAL_SERVICE' | 'PAYMENT_FEE' | 'CASH_IN' | 'CASH_OUT' | 'LOGISTICS_RECOVERY';

export interface Entry {
  account: Account; component: LComponent; side: 'DEBIT' | 'CREDIT'; amount: number;
  partyType?: 'BUYER' | 'SUPPLIER' | 'PLATFORM'; partyId?: string | null; memo?: string;
}

export const ASSET_ACCOUNTS: Account[] = ['CASH', 'LOGISTICS_RECEIVABLE'];
export const LIABILITY_ACCOUNTS: Account[] = ['SUPPLIER_PAYABLE', 'REFUND_PAYABLE', 'LOGISTICS_PAYABLE', 'TAX_PAYABLE'];
export const REVENUE_ACCOUNTS: Account[] = ['PLATFORM_FEE_REVENUE', 'PACKAGING_REVENUE', 'LOGISTICS_REVENUE', 'OPTIONAL_SERVICE_REVENUE', 'PAYMENT_FEE_COLLECTED'];
export const EXPENSE_ACCOUNTS: Account[] = ['PACKAGING_COST', 'LOGISTICS_COST', 'PAYMENT_PROCESSING_FEE', 'PROMOTION_DISCOUNT', 'RETURN_ADJUSTMENT'];

export async function postJournal(
  db: Db,
  j: { type: string; orderId?: string | null; returnCaseId?: string | null; reference?: string; memo?: string; createdBy?: string | null },
  entries: Entry[],
): Promise<string> {
  const es = entries.filter((e) => money(e.amount) !== 0);
  if (!es.length) throw bad('EMPTY_JOURNAL');
  if (es.some((e) => e.amount < 0)) throw bad('NEGATIVE_ENTRY');
  const dr = money(es.filter((e) => e.side === 'DEBIT').reduce((a, e) => a + e.amount, 0));
  const cr = money(es.filter((e) => e.side === 'CREDIT').reduce((a, e) => a + e.amount, 0));
  if (Math.abs(dr - cr) > 0.005) throw bad('UNBALANCED_JOURNAL', { type: j.type, debit: dr, credit: cr, entries: es });
  const jr = await one<{ id: string }>(
    db,
    `INSERT INTO ledger_journals(journal_type, order_id, return_case_id, reference, memo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [j.type, j.orderId ?? null, j.returnCaseId ?? null, j.reference ?? null, j.memo ?? null, j.createdBy ?? null],
  );
  for (const e of es) {
    await q(
      db,
      `INSERT INTO ledger_entries(journal_id, order_id, account, component, side, amount, party_type, party_id, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [jr.id, j.orderId ?? null, e.account, e.component, e.side, money(e.amount), e.partyType ?? null, e.partyId ?? null, e.memo ?? null],
    );
  }
  return jr.id;
}

export interface OrderPricingRow {
  id: string; buyer_id: string; supplier_id: string; order_no: string;
  product_value: number; platform_fee_amount: number; packaging_amount: number; logistics_amount: number;
  payment_fee_amount: number; optional_amount: number; discount_amount: number; tax_amount: number; total_amount: number;
  pricing_snapshot: any;
}

/** Jurnal saat pembayaran buyer diterima: kas masuk, kewajiban ke supplier, pendapatan platform, pajak terutang. */
export async function postBuyerPayment(db: Db, o: OrderPricingRow, createdBy?: string | null) {
  const entries: Entry[] = [
    { account: 'CASH', component: 'CASH_IN', side: 'DEBIT', amount: o.total_amount, partyType: 'BUYER', partyId: o.buyer_id, memo: `Pembayaran ${o.order_no}` },
    { account: 'SUPPLIER_PAYABLE', component: 'PRODUCT_VALUE', side: 'CREDIT', amount: o.product_value, partyType: 'SUPPLIER', partyId: o.supplier_id },
    { account: 'PLATFORM_FEE_REVENUE', component: 'PLATFORM_FEE_REVENUE', side: 'CREDIT', amount: o.platform_fee_amount, partyType: 'PLATFORM' },
    { account: 'PACKAGING_REVENUE', component: 'PACKAGING_REVENUE', side: 'CREDIT', amount: o.packaging_amount, partyType: 'PLATFORM' },
    { account: 'LOGISTICS_REVENUE', component: 'LOGISTICS_REVENUE', side: 'CREDIT', amount: o.logistics_amount, partyType: 'PLATFORM' },
    { account: 'OPTIONAL_SERVICE_REVENUE', component: 'OPTIONAL_SERVICE', side: 'CREDIT', amount: o.optional_amount, partyType: 'PLATFORM' },
    { account: 'PAYMENT_FEE_COLLECTED', component: 'PAYMENT_FEE', side: 'CREDIT', amount: o.payment_fee_amount, partyType: 'PLATFORM' },
    { account: 'TAX_PAYABLE', component: 'TAX_PAYABLE', side: 'CREDIT', amount: o.tax_amount, partyType: 'PLATFORM' },
    { account: 'PROMOTION_DISCOUNT', component: 'PROMOTION_DISCOUNT', side: 'DEBIT', amount: o.discount_amount, partyType: 'PLATFORM' },
  ];
  return postJournal(db, { type: 'BUYER_PAYMENT', orderId: o.id, reference: o.order_no, createdBy }, entries);
}

export async function postProviderFee(db: Db, o: OrderPricingRow, providerFee: number) {
  if (providerFee <= 0) return null;
  return postJournal(db, { type: 'PROVIDER_FEE', orderId: o.id, reference: o.order_no, memo: 'Biaya payment gateway dipotong provider' }, [
    { account: 'PAYMENT_PROCESSING_FEE', component: 'PAYMENT_PROCESSING_FEE', side: 'DEBIT', amount: providerFee, partyType: 'PLATFORM' },
    { account: 'CASH', component: 'CASH_OUT', side: 'CREDIT', amount: providerFee, partyType: 'PLATFORM' },
  ]);
}

export async function postPackagingCost(db: Db, o: OrderPricingRow, cost: number) {
  if (cost <= 0) return null;
  return postJournal(db, { type: 'PACKAGING_COST', orderId: o.id, reference: o.order_no, memo: 'Biaya packaging aktual' }, [
    { account: 'PACKAGING_COST', component: 'PACKAGING_COST', side: 'DEBIT', amount: cost, partyType: 'PLATFORM' },
    { account: 'CASH', component: 'CASH_OUT', side: 'CREDIT', amount: cost, partyType: 'PLATFORM' },
  ]);
}

export async function postLogisticsCost(db: Db, o: OrderPricingRow, cost: number, memo = 'Biaya logistik ke penyedia') {
  if (cost <= 0) return null;
  return postJournal(db, { type: 'LOGISTICS_COST', orderId: o.id, reference: o.order_no, memo }, [
    { account: 'LOGISTICS_COST', component: 'LOGISTICS_PAYABLE', side: 'DEBIT', amount: cost, partyType: 'PLATFORM' },
    { account: 'LOGISTICS_PAYABLE', component: 'LOGISTICS_PAYABLE', side: 'CREDIT', amount: cost, partyType: 'PLATFORM' },
  ]);
}

export async function postRefundPaid(db: Db, o: { id: string; order_no: string; buyer_id: string }, amount: number, returnCaseId?: string | null) {
  if (amount <= 0) return null;
  return postJournal(db, { type: 'REFUND_PAID', orderId: o.id, returnCaseId, reference: o.order_no, memo: 'Refund dibayarkan ke buyer' }, [
    { account: 'REFUND_PAYABLE', component: 'REFUND', side: 'DEBIT', amount, partyType: 'BUYER', partyId: o.buyer_id },
    { account: 'CASH', component: 'CASH_OUT', side: 'CREDIT', amount, partyType: 'BUYER', partyId: o.buyer_id },
  ]);
}

export async function accountBalances(db: Db, filter: { orderId?: string; partyId?: string } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.orderId) { params.push(filter.orderId); where.push(`order_id=$${params.length}`); }
  if (filter.partyId) { params.push(filter.partyId); where.push(`party_id=$${params.length}`); }
  const rows = await q<{ account: Account; side: 'DEBIT' | 'CREDIT'; total: number }>(
    db,
    `SELECT account, side, SUM(amount)::numeric AS total FROM ledger_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY account, side`,
    params,
  );
  const bal: Record<string, { debit: number; credit: number; net: number }> = {};
  for (const r of rows) {
    bal[r.account] ??= { debit: 0, credit: 0, net: 0 };
    bal[r.account][r.side === 'DEBIT' ? 'debit' : 'credit'] += Number(r.total);
  }
  for (const a of Object.keys(bal)) {
    const b = bal[a];
    // aset & beban: normal debit; liabilitas & pendapatan: normal kredit
    const normalDebit = ASSET_ACCOUNTS.includes(a as Account) || EXPENSE_ACCOUNTS.includes(a as Account);
    b.net = money(normalDebit ? b.debit - b.credit : b.credit - b.debit);
  }
  return bal;
}

/**
 * REKONSILIASI: Money In + Piutang klaim logistik = Money Out + Liability (supplier payable, refund payable, logistics payable) + Tax + Net Revenue.
 * Piutang (LOGISTICS_RECEIVABLE) adalah "valid adjustment": klaim ke penyedia logistik yang belum dibayar.
 * Karena semua jurnal seimbang, variance harus 0. Juga memeriksa setiap jurnal seimbang.
 */
export async function reconcile(db: Db, orderId?: string) {
  const bal = await accountBalances(db, { orderId });
  const g = (a: Account) => bal[a]?.net ?? 0;
  const moneyIn = money(bal.CASH?.debit ?? 0);
  const moneyOut = money(bal.CASH?.credit ?? 0);
  const liabilities = money(g('SUPPLIER_PAYABLE') + g('REFUND_PAYABLE') + g('LOGISTICS_PAYABLE'));
  const tax = g('TAX_PAYABLE');
  const revenue = money(REVENUE_ACCOUNTS.reduce((a, acc) => a + g(acc), 0));
  const expenses = money(EXPENSE_ACCOUNTS.reduce((a, acc) => a + g(acc), 0));
  const netRevenue = money(revenue - expenses);
  const receivables = g('LOGISTICS_RECEIVABLE');
  const variance = money(moneyIn + receivables - (moneyOut + liabilities + tax + netRevenue));

  const unbalanced = await q(
    db,
    `SELECT j.id, j.journal_type,
            SUM(CASE WHEN e.side='DEBIT' THEN e.amount ELSE 0 END) AS debit,
            SUM(CASE WHEN e.side='CREDIT' THEN e.amount ELSE 0 END) AS credit
     FROM ledger_journals j JOIN ledger_entries e ON e.journal_id=j.id
     ${orderId ? 'WHERE j.order_id=$1' : ''}
     GROUP BY j.id HAVING ABS(SUM(CASE WHEN e.side='DEBIT' THEN e.amount ELSE -e.amount END)) > 0.005`,
    orderId ? [orderId] : [],
  );
  return {
    moneyIn, moneyOut, receivables, liabilities, tax, revenue, expenses, netRevenue, variance,
    balanced: Math.abs(variance) < 0.005 && unbalanced.length === 0,
    unbalancedJournals: unbalanced,
    balances: bal,
    formula: 'Money In + Receivables (klaim logistik) = Money Out + Liability + Tax + Net Revenue',
  };
}
