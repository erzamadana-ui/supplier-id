import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';

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

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'SUPPLIER' | 'BUYER';
  orgId: string | null;
}
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(u: AuthUser) {
  return jwt.sign(u, JWT_SECRET, { expiresIn: '7d' });
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(h.slice(7), JWT_SECRET) as AuthUser;
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
