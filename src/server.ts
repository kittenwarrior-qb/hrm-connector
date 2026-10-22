import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { OdooClient } from './odoo/client.js';
import { AccountNotFoundError, type SyncEngine } from './sync/engine.js';

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createServer(engine: SyncEngine, odoo: OdooClient, apiKey: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  // Mọi route /api cần x-api-key (hoặc Authorization: Bearer <key>)
  app.use('/api', (req, res, next) => {
    const key = req.get('x-api-key') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!safeEqual(key, apiKey)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.get('/api/odoo/ping', async (_req, res) => {
    const version = await odoo.version();
    const uid = await odoo.authenticate();
    res.json({ ok: true, uid, version: version.server_version });
  });

  app.get('/api/accounts', (_req, res) => {
    res.json(engine.list());
  });

  app.get('/api/accounts/:id', (req, res) => {
    res.json(engine.get(req.params.id));
  });

  // Sync chạy nền (có thể mất vài phút); xem tiến độ qua GET /api/accounts/:id
  app.post('/api/accounts/:id/sync', (req, res) => {
    const { id } = req.params;
    const already = engine.isRunning(id);
    if (!already) void engine.syncAccount(id);
    res.status(202).json({ started: !already, state: engine.get(id) });
  });

  app.post('/api/sync', (_req, res) => {
    void engine.syncAll();
    res.status(202).json({ started: true });
  });

  // Tài khoản bật 2FA: CareerViet gửi OTP qua email -> gửi mã vào đây, xác thực xong tự sync
  app.post('/api/accounts/:id/otp', async (req, res) => {
    const code = String(req.body?.code ?? '').trim();
    if (!code) {
      res.status(400).json({ error: 'Thiếu "code"' });
      return;
    }
    await engine.submitOtp(req.params.id, code);
    void engine.syncAccount(req.params.id);
    res.json({ ok: true, syncing: true });
  });

  // Odoo gọi khi HR bấm "Đẩy thành ứng viên": email của các hồ sơ đã chọn.
  // Body: { folders: [{ folderRef, ids: [mã hồ sơ] }] } -> { emails: { mã hồ sơ: email } }
  app.post('/api/accounts/:id/contacts', async (req, res) => {
    const folders = req.body?.folders;
    const valid =
      Array.isArray(folders) &&
      folders.length <= 50 &&
      folders.every(
        (f: any) => typeof f?.folderRef === 'string' && Array.isArray(f.ids) && f.ids.length <= 500,
      );
    if (!valid) {
      res.status(400).json({ error: 'Body phải là { folders: [{ folderRef, ids }] }' });
      return;
    }
    res.json({ emails: await engine.fetchEmails(req.params.id, folders) });
  });

  // Odoo gọi khi HR bấm xem CV: stream PDF về, connector không giữ bản nào.
  app.get('/api/accounts/:id/resumes/:resumeRef/cv', async (req, res) => {
    const r = await engine.fetchCv(req.params.id, {
      resumeRef: req.params.resumeRef,
      candidateRef: typeof req.query.candidateRef === 'string' ? req.query.candidateRef : undefined,
      cvType: typeof req.query.cvType === 'string' ? req.query.cvType : undefined,
    });
    const type = r.headers.get('content-type') ?? '';
    if (!r.ok || !type.includes('pdf') || !r.body) {
      res.status(502).json({ error: `Trang nguồn trả ${r.status} ${type}` });
      await r.body?.cancel();
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(r.body as any).pipe(res);
  });

  // Xoá phiên đã lưu và đăng nhập lại từ đầu (vd. OTP hết hạn, đổi mật khẩu)
  app.post('/api/accounts/:id/relogin', (req, res) => {
    const { id } = req.params;
    if (engine.isRunning(id)) {
      res.status(409).json({ error: 'Account đang sync' });
      return;
    }
    engine.resetAuth(id);
    void engine.syncAccount(id);
    res.status(202).json({ started: true });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AccountNotFoundError ? 404 : err.name === 'AuthError' ? 400 : 500;
    if (status === 500) console.error('[http]', err);
    res.status(status).json({ error: err.message });
  });

  return app;
}
