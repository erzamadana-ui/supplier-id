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

export const publicUrl = (key: string) => `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${key}`;

/** Buat signed upload URL (klien mengunggah langsung ke Supabase Storage; tidak lewat API — aman untuk video besar). */
export async function createSignedUpload(ext: string): Promise<{ key: string; upload_url: string; token: string; public_url: string }> {
  if (storageMode !== 'supabase') throw new Error('DIRECT_UPLOAD_UNAVAILABLE');
  const key = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(16).slice(2, 10)}${ext}`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${SUPABASE_BUCKET}/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`SIGNED_UPLOAD_FAILED ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { url?: string; token?: string };
  const token = j.token || new URL(j.url || '', SUPABASE_URL).searchParams.get('token') || '';
  return { key, token, upload_url: `${SUPABASE_URL}/storage/v1/object/upload/sign/${SUPABASE_BUCKET}/${key}?token=${encodeURIComponent(token)}`, public_url: publicUrl(key) };
}

/** Verifikasi objek ada di bucket (HEAD) setelah klien selesai mengunggah. */
export async function objectExists(key: string): Promise<{ ok: boolean; size?: number; type?: string }> {
  const r = await fetch(publicUrl(key), { method: 'HEAD' });
  return { ok: r.ok, size: Number(r.headers.get('content-length') || 0), type: r.headers.get('content-type') || undefined };
}

/** Hapus objek di Storage (dipakai purge data uji). URL publik → key. Gagal tidak melempar; mengembalikan jumlah yang terhapus. */
export async function deleteObjects(filePaths: string[]): Promise<number> {
  if (storageMode !== 'supabase') {
    let n = 0;
    for (const p of filePaths) { try { fs.unlinkSync(path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), path.basename(p))); n++; } catch { /* abaikan */ } }
    return n;
  }
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/`;
  const keys = filePaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  if (!keys.length) return 0;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: keys }),
  });
  if (!r.ok) return 0;
  const j = (await r.json().catch(() => [])) as unknown[];
  return Array.isArray(j) ? j.length : keys.length;
}
