import fs from 'node:fs';
import path from 'node:path';

/**
 * Penyimpanan bukti. Default: disk lokal (UPLOAD_DIR, disajikan di /uploads).
 * Produksi: Supabase Storage bila SUPABASE_URL + SUPABASE_SERVICE_KEY + SUPABASE_BUCKET diisi → file_path berisi URL publik.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET;

export const storageMode = SUPABASE_URL && SUPABASE_SERVICE_KEY && SUPABASE_BUCKET ? 'supabase' : 'local';

/** Mengembalikan nilai untuk kolom evidence_files.file_path (basename lokal, atau URL publik). */
export async function storeEvidence(localPath: string, mimeType: string): Promise<string> {
  if (storageMode !== 'supabase') return path.basename(localPath);
  const key = `${new Date().toISOString().slice(0, 10)}/${path.basename(localPath)}`;
  const body = fs.readFileSync(localPath);
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY!, 'Content-Type': mimeType, 'x-upsert': 'true', 'cache-control': '31536000' },
    body,
  });
  if (!r.ok) throw new Error(`STORAGE_UPLOAD_FAILED ${r.status} ${await r.text()}`);
  fs.unlink(localPath, () => undefined);
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${key}`;
}
