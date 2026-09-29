import { Db, q, maybe, one } from '../db';
import { bad } from '../lib/http';

export async function getSetting<T = any>(db: Db, key: string, fallback?: T): Promise<T> {
  const r = await maybe<{ value: T }>(db, 'SELECT value FROM settings WHERE key=$1', [key]);
  if (!r) {
    if (fallback !== undefined) return fallback;
    throw bad(`SETTING_MISSING:${key}`);
  }
  return r.value;
}

export async function setSetting(db: Db, key: string, value: any, userId: string | null, reason?: string) {
  const before = await maybe(db, 'SELECT value FROM settings WHERE key=$1', [key]);
  await q(
    db,
    `INSERT INTO settings(key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(value), userId],
  );
  await audit(db, 'settings', key, before ? 'UPDATE' : 'CREATE', before?.value ?? null, value, userId, reason);
}

export async function audit(
  db: Db, entity: string, entityId: string, action: string,
  before: any, after: any, userId: string | null, reason?: string,
) {
  await q(
    db,
    `INSERT INTO config_audit_logs(entity, entity_id, action, before, after, reason, user_id)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
    [entity, entityId, action, JSON.stringify(before), JSON.stringify(after), reason ?? null, userId],
  );
}

export interface FeeContext {
  at?: Date;
  categoryId?: string;
  supplierId?: string;
  buyerId?: string;
  contractRef?: string;
  promoCode?: string;
  region?: string;
  productValue?: number;
}

/** Urutan prioritas override: CONTRACT > PROMOTION > BUYER > SUPPLIER > CATEGORY > REGION > VALUE_TIER > GLOBAL */
const SCOPE_PRIORITY = ['CONTRACT', 'PROMOTION', 'BUYER', 'SUPPLIER', 'CATEGORY', 'REGION', 'VALUE_TIER', 'GLOBAL'] as const;

export interface ResolvedFee { id: string; rate_percent: number; scope_type: string; scope_ref: string | null; effective_from: string }

export async function resolvePlatformFee(db: Db, ctx: FeeContext = {}): Promise<ResolvedFee> {
  const at = ctx.at ?? new Date();
  const rows = await q<ResolvedFee & { effective_to: string | null }>(
    db,
    `SELECT id, rate_percent, scope_type, scope_ref, effective_from, effective_to
     FROM fee_configs
     WHERE fee_key='PLATFORM_FEE' AND status='ACTIVE'
       AND effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1)
     ORDER BY effective_from DESC`,
    [at],
  );
  const refOf: Record<string, string | undefined> = {
    CONTRACT: ctx.contractRef, PROMOTION: ctx.promoCode, BUYER: ctx.buyerId, SUPPLIER: ctx.supplierId,
    CATEGORY: ctx.categoryId, REGION: ctx.region,
  };
  for (const scope of SCOPE_PRIORITY) {
    const candidates = rows.filter((r) => r.scope_type === scope);
    for (const c of candidates) {
      if (scope === 'GLOBAL') return c;
      if (scope === 'VALUE_TIER') {
        const [min, max] = String(c.scope_ref ?? '0-').split('-').map((x) => (x === '' ? Infinity : Number(x)));
        const v = ctx.productValue ?? 0;
        if (v >= min && v < max) return c;
        continue;
      }
      if (refOf[scope] && c.scope_ref === refOf[scope]) return c;
    }
  }
  throw bad('NO_ACTIVE_PLATFORM_FEE');
}

export interface TaxRule {
  id: string; name: string; component: string; transaction_type: string; seller_status: string;
  buyer_status: string; service_type: string; taxable: boolean; rate_percent: number; dpp_factor: number; priority: number;
}

export async function loadTaxRules(db: Db, at = new Date()): Promise<TaxRule[]> {
  return q<TaxRule>(
    db,
    `SELECT * FROM tax_rules WHERE active AND effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1)
     ORDER BY priority ASC, effective_from DESC`,
    [at],
  );
}

export async function getCategoryOfBatch(db: Db, batchId: string) {
  return one<{ category_id: string; tax_class: string; packaging_rate_per_unit: number | null; min_photos: number | null; code: string }>(
    db,
    `SELECT c.id AS category_id, c.tax_class, c.packaging_rate_per_unit, c.min_photos, c.code
     FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id WHERE b.id=$1`,
    [batchId],
  );
}
