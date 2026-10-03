import { Db, q } from '../db';

/** Notifikasi in-app (per organisasi atau per user). Push (FCM) menyusul setelah akun Firebase tersedia — token disimpan di push_tokens. */
export async function notify(db: Db, a: { orgId?: string | null; userId?: string | null; kind: string; title: string; body?: string; link?: string }) {
  await q(db, `INSERT INTO notifications(user_id, org_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.userId ?? null, a.orgId ?? null, a.kind, a.title, a.body ?? null, a.link ?? null]);
}
