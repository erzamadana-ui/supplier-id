import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';
import { pool, maybe } from '../db';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
  }
}
export const bad = (msg: string, details?: any) => new HttpError(400, msg, details);
export const forbidden = (msg = 'FORBIDDEN') => new HttpError(403, msg);
export const notFound = (msg = 'NOT_FOUND') => new HttpError(404, msg);
export const conflict = (msg: string, details?: any) => new HttpError(409, msg, details);

export type Role = 'ADMIN' | 'SUPPLIER' | 'BUYER' | 'COURIER';
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  orgId: string | null;
  adminRole?: string | null;     // OWNER | OPS | QC | WAREHOUSE | DISPATCHER | CS | FINANCE_MAKER | FINANCE_CHECKER | AUDITOR
  permissions?: string[];        // izin efektif (preset admin_role + tambahan)
}

/** Preset izin per peran admin. Peran boleh digabung secara bisnis, izin tetap terpisah (maker ≠ checker). */
export const ADMIN_ROLE_PERMS: Record<string, string[]> = {
  OWNER: ['*'],
  OPS: ['orders.read', 'orders.manage', 'tasks.read', 'tasks.manage', 'escalations.manage', 'partners.read', 'partners.manage', 'catalog.manage', 'settings.read', 'reports.read', 'tickets.read'],
  QC: ['orders.read', 'tasks.read', 'qc.manage', 'partners.read'],
  WAREHOUSE: ['orders.read', 'tasks.read', 'packing.manage', 'labels.print', 'scan'],
  DISPATCHER: ['orders.read', 'shipments.manage', 'scan', 'couriers.manage'],
  CS: ['orders.read', 'tickets.read', 'tickets.manage', 'returns.read', 'returns.decide', 'refunds.request', 'partners.read'],
  FINANCE_MAKER: ['orders.read', 'finance.read', 'payouts.make', 'payouts.process', 'ledger.read', 'reports.read'],
  FINANCE_CHECKER: ['orders.read', 'finance.read', 'payouts.check', 'ledger.read', 'reports.read', 'fees.approve'],
  AUDITOR: ['orders.read', 'finance.read', 'ledger.read', 'reports.read', 'audit.read', 'tickets.read', 'returns.read', 'tasks.read', 'partners.read', 'settings.read'],
};

export function effectivePermissions(role: Role, adminRole?: string | null, extra: string[] = []): string[] {
  if (role !== 'ADMIN') return extra;
  const preset = ADMIN_ROLE_PERMS[adminRole ?? 'OWNER'] ?? ADMIN_ROLE_PERMS.OWNER; // admin lama tanpa admin_role = OWNER
  return Array.from(new Set([...preset, ...extra]));
}

export const hasPerm = (u: AuthUser | undefined, perm: string) => !!u && u.role === 'ADMIN' && ((u.permissions ?? []).includes('*') || (u.permissions ?? []).includes(perm));

/** Izin granular admin (server-side). OWNER selalu lolos. */
export function requirePerm(...perms: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED'));
    if (req.user.role !== 'ADMIN') return next(forbidden());
    if (!perms.some((p) => hasPerm(req.user, p))) return next(new HttpError(403, 'PERMISSION_REQUIRED', { required: perms, admin_role: req.user.adminRole }));
    next();
  };
}
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(u: AuthUser, tokenVersion = 0) {
  return jwt.sign({ ...u, tv: tokenVersion }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Autentikasi JWT + verifikasi ke DB: user masih ada dan token_version cocok
 * (ganti kata sandi / penghapusan akun mencabut token lama). Token tidak valid → anonim.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const t = jwt.verify(h.slice(7), JWT_SECRET) as AuthUser & { tv?: number };
      const row = await maybe<{ role: AuthUser['role']; org_id: string | null; token_version: number; admin_role: string | null; permissions: string[]; active: boolean }>(pool, 'SELECT role, org_id, token_version, admin_role, permissions, active FROM users WHERE id=$1', [t.id]);
      if (row && row.active !== false && (t.tv ?? 0) === row.token_version) {
        req.user = { id: t.id, email: t.email, name: t.name, role: row.role, orgId: row.org_id, adminRole: row.admin_role, permissions: effectivePermissions(row.role, row.admin_role, row.permissions ?? []) };
      }
    } catch {
      /* token tidak valid → anonim */
    }
  }
  next();
}

export function requireRole(...roles: AuthUser['role'][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED'));
    if (roles.length && !roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const asyncH =
  (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw bad('VALIDATION_ERROR', r.error.flatten());
  return r.data;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'INTERNAL_ERROR', details: err.details });
}

/** Pembulatan uang: ke rupiah penuh (2 desimal disimpan, tapi kita pakai satuan rupiah bulat). */
export const money = (n: number) => Math.round(n * 100) / 100;
