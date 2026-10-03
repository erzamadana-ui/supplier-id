import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, q, maybe, one, tx } from '../db';
import { asyncH, parse, bad, signToken, requireRole, HttpError, effectivePermissions } from '../lib/http';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(2),
  role: z.enum(['SUPPLIER', 'BUYER']),
  orgName: z.string().min(2).optional(),          // BUYER perorangan boleh kosong → memakai nama
  buyerKind: z.enum(['INDIVIDU', 'BISNIS']).optional(),
  phone: z.string().optional(),
  supplierKind: z.enum(['PETANI', 'PETERNAK', 'NELAYAN', 'SUPPLIER', 'KELOMPOK_TANI', 'KOPERASI', 'PRODUSEN']).optional(),
  taxStatus: z.enum(['PKP', 'NON_PKP']).default('NON_PKP'),
  region: z.string().optional(),
  address: z.string().optional(),
});

authRouter.post('/register', asyncH(async (req, res) => {
  const b = parse(registerSchema, req.body);
  if (b.role === 'SUPPLIER' && !b.orgName) throw bad('ORG_NAME_REQUIRED');
  const buyerKind = b.role === 'BUYER' ? (b.buyerKind ?? (b.orgName ? 'BISNIS' : 'INDIVIDU')) : null;
  const orgName = b.orgName ?? b.name;
  if (await maybe(pool, 'SELECT 1 FROM users WHERE email=$1', [b.email])) throw bad('EMAIL_EXISTS');
  const r = await tx(async (c) => {
    const org = await one(c,
      `INSERT INTO organizations(type, name, supplier_kind, tax_status, region, address, buyer_kind, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.role, orgName, b.role === 'SUPPLIER' ? b.supplierKind ?? 'SUPPLIER' : null, buyerKind === 'INDIVIDU' ? 'NON_PKP' : b.taxStatus, b.region ?? null, b.address ?? null, buyerKind, b.phone ?? null]);
    const u = await one(c,
      `INSERT INTO users(email, password_hash, name, role, org_id, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, role, org_id`,
      [b.email, await bcrypt.hash(b.password, 10), b.name, b.role, org.id, b.phone ?? null]);
    return { u, org };
  });
  const user = { id: r.u.id, email: r.u.email, name: r.u.name, role: r.u.role, orgId: r.u.org_id };
  res.status(201).json({ token: signToken(user), user, organization: r.org });
}));

authRouter.post('/login', asyncH(async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string() }), req.body);
  const u = await maybe(pool, 'SELECT * FROM users WHERE email=$1', [b.email]);
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS');
  if (u.active === false) throw new HttpError(403, 'ACCOUNT_INACTIVE');
  const user = { id: u.id, email: u.email, name: u.name, role: u.role, orgId: u.org_id, adminRole: u.admin_role, permissions: effectivePermissions(u.role, u.admin_role, u.permissions ?? []) };
  const org = u.org_id ? await maybe(pool, 'SELECT * FROM organizations WHERE id=$1', [u.org_id]) : null;
  await q(pool, 'UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
  res.json({ token: signToken({ id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.orgId }, u.token_version ?? 0), user, organization: org });
}));

/** Ganti kata sandi akun sendiri (wajib kata sandi lama). */
authRouter.post('/change-password', requireRole(), asyncH(async (req, res) => {
  const b = parse(z.object({ current_password: z.string().min(1), new_password: z.string().min(8).max(128) }), req.body);
  if (b.current_password === b.new_password) throw bad('PASSWORD_UNCHANGED', 'Kata sandi baru harus berbeda');
  const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [req.user!.id]);
  if (!(await bcrypt.compare(b.current_password, u.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS');
  // token_version naik → semua sesi lama (termasuk token yang dipakai saat ini) dicabut; kembalikan token baru untuk sesi ini
  const upd = await one(pool, 'UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 RETURNING token_version', [u.id, await bcrypt.hash(b.new_password, 10)]);
  res.json({ ok: true, token: signToken(req.user!, upd.token_version) });
}));

authRouter.get('/me', requireRole(), asyncH(async (req, res) => {
  const org = req.user!.orgId ? await maybe(pool, 'SELECT * FROM organizations WHERE id=$1', [req.user!.orgId]) : null;
  res.json({ user: req.user, organization: org });
}));
