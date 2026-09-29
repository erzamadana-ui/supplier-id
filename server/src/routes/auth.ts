import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, q, maybe, one, tx } from '../db';
import { asyncH, parse, bad, signToken, requireRole, HttpError } from '../lib/http';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(2),
  role: z.enum(['SUPPLIER', 'BUYER']),
  orgName: z.string().min(2),
  supplierKind: z.enum(['PETANI', 'PETERNAK', 'NELAYAN', 'SUPPLIER', 'KELOMPOK_TANI', 'KOPERASI', 'PRODUSEN']).optional(),
  taxStatus: z.enum(['PKP', 'NON_PKP']).default('NON_PKP'),
  region: z.string().optional(),
  address: z.string().optional(),
});

authRouter.post('/register', asyncH(async (req, res) => {
  const b = parse(registerSchema, req.body);
  if (await maybe(pool, 'SELECT 1 FROM users WHERE email=$1', [b.email])) throw bad('EMAIL_EXISTS');
  const r = await tx(async (c) => {
    const org = await one(c,
      `INSERT INTO organizations(type, name, supplier_kind, tax_status, region, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.role, b.orgName, b.role === 'SUPPLIER' ? b.supplierKind ?? 'SUPPLIER' : null, b.taxStatus, b.region ?? null, b.address ?? null]);
    const u = await one(c,
      `INSERT INTO users(email, password_hash, name, role, org_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, org_id`,
      [b.email, await bcrypt.hash(b.password, 10), b.name, b.role, org.id]);
    return { u, org };
  });
  const user = { id: r.u.id, email: r.u.email, name: r.u.name, role: r.u.role, orgId: r.u.org_id };
  res.status(201).json({ token: signToken(user), user, organization: r.org });
}));

authRouter.post('/login', asyncH(async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string() }), req.body);
  const u = await maybe(pool, 'SELECT * FROM users WHERE email=$1', [b.email]);
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS');
  const user = { id: u.id, email: u.email, name: u.name, role: u.role, orgId: u.org_id };
  const org = u.org_id ? await maybe(pool, 'SELECT * FROM organizations WHERE id=$1', [u.org_id]) : null;
  res.json({ token: signToken(user), user, organization: org });
}));

authRouter.get('/me', requireRole(), asyncH(async (req, res) => {
  const org = req.user!.orgId ? await maybe(pool, 'SELECT * FROM organizations WHERE id=$1', [req.user!.orgId]) : null;
  res.json({ user: req.user, organization: org });
}));
