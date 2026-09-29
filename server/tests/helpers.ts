import request from 'supertest';
import { Express } from 'express';
import { expect } from 'vitest';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), Buffer.alloc(64, 1)]);

export class Api {
  constructor(public app: Express, public token = '') {}
  async login(email: string, password = 'Password123') {
    const r = await request(this.app).post('/api/auth/login').send({ email, password });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    this.token = r.body.token;
    return r.body;
  }
  private auth(req: request.Test) { return this.token ? req.set('Authorization', `Bearer ${this.token}`) : req; }
  async get(url: string, expected = 200) {
    const r = await this.auth(request(this.app).get(url));
    expect(r.status, `${url} → ${JSON.stringify(r.body)}`).toBe(expected);
    return r.body;
  }
  async post(url: string, body: any = {}, expected: number | number[] = [200, 201]) {
    const r = await this.auth(request(this.app).post(url)).send(body);
    const ok = Array.isArray(expected) ? expected : [expected];
    expect(ok, `${url} → ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    return r.body;
  }
  async put(url: string, body: any = {}, expected = 200) {
    const r = await this.auth(request(this.app).put(url)).send(body);
    expect(r.status, `${url} → ${JSON.stringify(r.body)}`).toBe(expected);
    return r.body;
  }
  async patch(url: string, body: any = {}, expected = 200) {
    const r = await this.auth(request(this.app).patch(url)).send(body);
    expect(r.status, `${url} → ${JSON.stringify(r.body)}`).toBe(expected);
    return r.body;
  }
  /** Unggah bukti foto/video (multipart). */
  async upload(meta: Record<string, any>, video = false, expected = 201) {
    let req = this.auth(request(this.app).post('/api/evidence'));
    for (const [k, v] of Object.entries(meta)) if (v !== undefined) req = req.field(k, String(v));
    req = video ? req.attach('file', MP4, { filename: 'bukti.mp4', contentType: 'video/mp4' }) : req.attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' });
    const r = await req;
    expect(r.status, `upload → ${JSON.stringify(r.body)}`).toBe(expected);
    return r.body;
  }
}

export const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + Number(b), 0) * 100) / 100;
