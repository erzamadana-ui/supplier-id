import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, q, one, maybe } from '../db';
import { asyncH, parse, bad, forbidden, requireRole } from '../lib/http';
import { storeEvidence } from '../lib/storage';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname || '')}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('ONLY_IMAGE_OR_VIDEO'));
  },
});

export const evidenceRouter = Router();

const metaSchema = z.object({
  owner_type: z.enum(['BATCH', 'HARVEST_CURRENT', 'HARVEST_PRE', 'HARVEST_FINAL', 'INSPECTION', 'RETURN', 'SHIPMENT']),
  kind: z.enum(['OVERALL', 'CLOSEUP', 'PACKAGING', 'CURRENT', 'PRE_HARVEST', 'FINAL', 'RECEIVING_PHOTO', 'RECEIVING_VIDEO', 'RETURN_PHOTO', 'RETURN_VIDEO', 'PICKUP', 'OTHER']),
  batch_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  shipment_id: z.string().uuid().optional(),
  inspection_id: z.string().uuid().optional(),
  return_case_id: z.string().uuid().optional(),
  taken_at: z.string().optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  location_consent: z.coerce.boolean().optional(),
  is_stock_image: z.coerce.boolean().optional(),
});

/**
 * Unggah bukti (foto/video). multipart/form-data: file + metadata.
 * Foto deklarasi WAJIB dari barang aktual; stock image ditolak (is_stock_image=true → 400).
 */
evidenceRouter.post('/', requireRole('SUPPLIER', 'BUYER', 'ADMIN'), upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) throw bad('FILE_REQUIRED');
  const m = parse(metaSchema, req.body);
  if (m.is_stock_image) { fs.unlinkSync(req.file.path); throw bad('STOCK_IMAGE_NOT_ALLOWED', 'Foto deklarasi kualitas harus foto aktual barang/batch yang dijual'); }
  const isVideo = req.file.mimetype.startsWith('video/');
  if (['RECEIVING_VIDEO', 'RETURN_VIDEO'].includes(m.kind) && !isVideo) throw bad('VIDEO_REQUIRED_FOR_KIND');
  if (!['RECEIVING_VIDEO', 'RETURN_VIDEO', 'OTHER'].includes(m.kind) && isVideo) throw bad('IMAGE_REQUIRED_FOR_KIND');

  let supplierId: string | null = null, buyerId: string | null = null, productId: string | null = null, harvestId: string | null = null;
  const u = req.user!;
  if (m.batch_id) {
    const b = await one(pool, 'SELECT * FROM batches WHERE id=$1', [m.batch_id]);
    if (u.role === 'SUPPLIER' && b.supplier_id !== u.orgId) throw forbidden();
    supplierId = b.supplier_id; productId = b.product_id;
    const h = await maybe(pool, 'SELECT id FROM harvests WHERE batch_id=$1', [b.id]);
    harvestId = h?.id ?? null;
  }
  if (m.order_id) {
    const o = await one(pool, 'SELECT * FROM orders WHERE id=$1', [m.order_id]);
    if (u.role === 'BUYER' && o.buyer_id !== u.orgId) throw forbidden();
    if (u.role === 'SUPPLIER' && o.supplier_id !== u.orgId) throw forbidden();
    buyerId = o.buyer_id; supplierId = o.supplier_id; productId = o.product_id;
    m.batch_id = m.batch_id ?? o.batch_id;
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
  const consent = !!m.location_consent;
  const storedPath = await storeEvidence(req.file.path, req.file.mimetype);
  const row = await one(
    pool,
    `INSERT INTO evidence_files(owner_type, kind, media_type, file_path, sha256, supplier_id, buyer_id, product_id, batch_id, harvest_id,
       order_id, shipment_id, inspection_id, return_case_id, taken_at, uploaded_by, lat, lng, location_consent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [m.owner_type, m.kind, req.file.mimetype, storedPath, sha, supplierId, buyerId, productId, m.batch_id ?? null, harvestId,
      m.order_id ?? null, m.shipment_id ?? null, m.inspection_id ?? null, m.return_case_id ?? null,
      m.taken_at ? new Date(m.taken_at) : null, u.id, consent ? m.lat ?? null : null, consent ? m.lng ?? null : null, consent],
  );
  res.status(201).json(row);
}));

evidenceRouter.get('/', requireRole(), asyncH(async (req, res) => {
  const { batch_id, order_id, return_case_id } = req.query as Record<string, string>;
  const where: string[] = []; const params: any[] = [];
  if (batch_id) { params.push(batch_id); where.push(`batch_id=$${params.length}`); }
  if (order_id) { params.push(order_id); where.push(`order_id=$${params.length}`); }
  if (return_case_id) { params.push(return_case_id); where.push(`return_case_id=$${params.length}`); }
  if (!where.length) throw bad('FILTER_REQUIRED');
  res.json(await q(pool, `SELECT * FROM evidence_files WHERE ${where.join(' AND ')} ORDER BY uploaded_at`, params));
}));
