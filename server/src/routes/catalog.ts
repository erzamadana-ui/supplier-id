import { Router } from 'express';
import { pool, q, one, maybe } from '../db';
import { asyncH } from '../lib/http';
import { latestQualityScore } from '../services/quality';

export const catalogRouter = Router();

catalogRouter.get('/categories', asyncH(async (_req, res) => {
  res.json(await q(pool, 'SELECT * FROM categories WHERE active ORDER BY name'));
}));

catalogRouter.get('/optional-services', asyncH(async (_req, res) => {
  const r = await maybe(pool, `SELECT value FROM settings WHERE key='optional_services'`);
  res.json(r?.value ?? []);
}));

catalogRouter.get('/reason-codes', asyncH(async (_req, res) => {
  res.json(await q(pool, 'SELECT * FROM return_reason_codes WHERE active ORDER BY sort_order'));
}));

catalogRouter.get('/declaration', asyncH(async (_req, res) => {
  res.json(await one(pool, 'SELECT * FROM declaration_versions WHERE active ORDER BY version DESC LIMIT 1'));
}));

/** Listing publik: batch READY_FOR_ORDER (ready stock / panen final) dan UPCOMING (akan panen). */
catalogRouter.get('/listings', asyncH(async (req, res) => {
  const { category, commodity, region, status } = req.query as Record<string, string>;
  const where: string[] = [`b.status IN ('READY_FOR_ORDER','UPCOMING','PRE_HARVEST_UPDATED')`, `p.status IN ('ACTIVE','UPCOMING_HARVEST')`, `o.status NOT IN ('SUSPENDED','UNDER_REVIEW')`];
  const params: any[] = [];
  if (category) { params.push(category); where.push(`c.code=$${params.length}`); }
  if (commodity) { params.push(`%${commodity}%`); where.push(`(p.commodity ILIKE $${params.length} OR p.name ILIKE $${params.length})`); }
  if (region) { params.push(`%${region}%`); where.push(`o.region ILIKE $${params.length}`); }
  if (status) { params.push(status); where.push(`b.status=$${params.length}`); }
  const rows = await q(
    pool,
    `SELECT b.*, p.name AS product_name, p.commodity, p.variety, p.origin, p.production_method, p.certification,
            c.code AS category_code, c.name AS category_name, o.name AS supplier_name, o.region AS supplier_region, o.status AS supplier_status,
            o.supplier_kind, o.verified AS supplier_verified,
            (SELECT COUNT(*) FROM evidence_files e WHERE e.batch_id=b.id AND e.owner_type IN ('BATCH','HARVEST_CURRENT','HARVEST_PRE','HARVEST_FINAL'))::int AS photo_count,
            (SELECT score FROM supplier_quality_scores s WHERE s.supplier_id=o.id ORDER BY computed_at DESC LIMIT 1) AS supplier_quality_score,
            hv.stage AS harvest_stage, hv.expected_harvest_date, hv.expected_quantity, hv.forecast_confidence
     FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id
     JOIN organizations o ON o.id=b.supplier_id LEFT JOIN harvests hv ON hv.batch_id=b.id
     WHERE ${where.join(' AND ')}
     ORDER BY o.status='ACTIVE' DESC, supplier_quality_score DESC NULLS LAST, b.published_at DESC NULLS LAST`,
    params,
  );
  res.json(rows);
}));

catalogRouter.get('/listings/:batchId', asyncH(async (req, res) => {
  const b = await one(
    pool,
    `SELECT b.*, p.name AS product_name, p.commodity, p.variety, p.origin, p.production_method, p.certification, p.category_id,
            c.code AS category_code, c.name AS category_name, c.attribute_schema, o.name AS supplier_name, o.region AS supplier_region,
            o.status AS supplier_status, o.supplier_kind, o.tax_status AS supplier_tax_status
     FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id JOIN organizations o ON o.id=b.supplier_id
     WHERE b.id=$1`,
    [req.params.batchId],
  );
  const photos = await q(pool, `SELECT id, owner_type, kind, media_type, file_path, taken_at, uploaded_at, lat, lng FROM evidence_files WHERE batch_id=$1 ORDER BY uploaded_at`, [b.id]);
  const harvest = await maybe(pool, 'SELECT * FROM harvests WHERE batch_id=$1', [b.id]);
  const declaration = await maybe(pool, 'SELECT declaration_version, accepted_at FROM declaration_acceptances WHERE batch_id=$1 ORDER BY accepted_at DESC LIMIT 1', [b.id]);
  const quality = await latestQualityScore(pool, b.supplier_id);
  res.json({ ...b, photos, harvest, declaration, supplier_quality: quality });
}));
