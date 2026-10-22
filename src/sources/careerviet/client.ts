import fs from 'node:fs';
import path from 'node:path';
import type { AccountConfig } from '../../config.js';
import { logger, sleep, type Logger } from '../../logger.js';
import { AuthError, OtpRequiredError } from '../types.js';

const SITE = 'https://careerviet.vn';
const API = 'https://internal-api.careerviet.vn/api/v1';
const PAGE_SIZE = 50;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

type Json = Record<string, any>;

/**
 * Client HR Central của CareerViet cho 1 account.
 * Phiên đăng nhập nằm trong cookie httpOnly của careerviet.vn; /check đổi cookie lấy JWT (~60 phút)
 * dùng cho internal-api.
 */
export class CareerVietClient {
  private cookies = new Map<string, string>();
  private cookiesLoaded = false;
  private token?: string;
  private pendingMfa?: { token: string; type: string };
  private log: Logger;
  userId?: string | number;

  constructor(
    private account: AccountConfig,
    private cookieFile: string,
  ) {
    this.log = logger(`careerviet:${account.id}`);
  }

  get otpPending() {
    return !!this.pendingMfa;
  }

  // ---------- cookie ----------
  private loadCookies() {
    if (this.cookiesLoaded) return;
    this.cookiesLoaded = true;
    try {
      const saved = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(saved)) this.cookies.set(k, v);
    } catch {
      // chưa có file
    }
    if (this.cookies.size === 0 && this.account.cookie) {
      for (const part of this.account.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
    }
  }

  private saveCookies() {
    fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
    fs.writeFileSync(this.cookieFile, JSON.stringify(Object.fromEntries(this.cookies)), { mode: 0o600 });
  }

  private storeCookies(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';', 1)[0];
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  /** fetch tới careerviet.vn, tự gửi/nhận cookie và tự theo redirect (để không mất Set-Cookie trung gian) */
  private async siteFetch(url: string, init: RequestInit = {}, redirects = 5): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', UA);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json, text/html;q=0.9');
    headers.set('Origin', SITE);
    if (!headers.has('Referer')) headers.set('Referer', SITE + '/');
    if (this.cookies.size) {
      headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    this.storeCookies(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc && redirects > 0) {
      await res.body?.cancel();
      return this.siteFetch(new URL(loc, url).toString(), {}, redirects - 1);
    }
    return res;
  }

  // ---------- auth ----------
  private async check(): Promise<Json | null> {
    try {
      const r = await this.siteFetch(`${SITE}/api/auth/employers/check`);
      if (r.status !== 200) return null;
      const j = (await r.json()) as Json;
      return j?.token?.accessToken ? j : null;
    } catch {
      return null;
    }
  }

  private async login() {
    const { username, password } = this.account;
    if (!username || !password) {
      throw new AuthError('Không có phiên hợp lệ và thiếu username/password trong accounts.json');
    }
    this.cookies.clear();
    await (await this.siteFetch(`${SITE}/vi/employers/login`)).text(); // lấy cookie khởi tạo
    const r = await this.siteFetch(`${SITE}/api/auth/employers/login`, {
      method: 'POST',
      headers: { lang: 'vi', 'Content-Type': 'application/json', Referer: `${SITE}/vi/employers/login` },
      body: JSON.stringify({ username, password }),
    });
    const j = ((await r.json().catch(() => ({}))) ?? {}) as Json;
    const data: Json = j.data && typeof j.data === 'object' ? j.data : j;

    if (r.status >= 400 || j.success === false) {
      throw new AuthError(`Đăng nhập thất bại (${r.status}): ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
    }

    // Tài khoản bật xác thực 2 lớp -> CareerViet gửi OTP qua email, chờ người dùng gửi mã qua API
    if (data.mfa_required) {
      const type = data.mfa_type ?? 'EMAIL_OTP';
      this.pendingMfa = { token: data.mfa_session_token, type };
      this.log.warn(`cần OTP (${type}), kiểm tra email`);
      throw new OtpRequiredError(type);
    }
    this.log.info('đăng nhập thành công');
  }

  async submitOtp(code: string) {
    if (!this.pendingMfa) throw new AuthError('Không có phiên OTP đang chờ — hãy chạy sync trước');
    const r = await this.siteFetch(`${SITE}/api/auth/employers/mfa/verify`, {
      method: 'POST',
      headers: { lang: 'vi', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mfa_session_token: this.pendingMfa.token,
        mfa_type: this.pendingMfa.type,
        otp: code,
        code,
      }),
    });
    if (r.status >= 400) {
      throw new AuthError(`Xác thực OTP thất bại (${r.status}): ${(await r.text()).slice(0, 200)}`);
    }
    this.pendingMfa = undefined;
    this.token = undefined;
    await this.ensureToken();
    this.log.info('xác thực OTP thành công');
  }

  resetAuth() {
    this.pendingMfa = undefined;
    this.token = undefined;
    this.cookies.clear();
    this.cookiesLoaded = true;
    fs.rmSync(this.cookieFile, { force: true });
  }

  /** Hạn token đọc thẳng từ JWT: /check có thể trả lại access token cũ ĐÃ hết hạn (sau ~60 phút) */
  private static fresh(token?: string) {
    if (!token) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      return Date.now() / 1000 < Number(exp) - 120;
    } catch {
      return false;
    }
  }

  /** Phiên (cookie) còn sống nhưng access token hết hạn -> xin token mới, giống frontend HR Central */
  private async refresh(): Promise<string | undefined> {
    try {
      const r = await this.siteFetch(`${SITE}/api/auth/employers/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const j = ((await r.json().catch(() => ({}))) ?? {}) as Json;
      return j.success ? j.token?.accessToken : undefined;
    } catch {
      return undefined;
    }
  }

  async ensureToken() {
    if (CareerVietClient.fresh(this.token)) return;
    // Đang chờ OTP thì không đăng nhập lại, tránh CareerViet gửi thêm mã mới
    if (this.pendingMfa) throw new OtpRequiredError(this.pendingMfa.type);

    this.loadCookies();
    let j = await this.check();
    let token: string | undefined = j?.token?.accessToken;
    if (j && !CareerVietClient.fresh(token)) token = await this.refresh();
    if (!CareerVietClient.fresh(token)) {
      this.log.info('phiên hết hạn -> đăng nhập lại');
      await this.login();
      j = await this.check();
      token = j?.token?.accessToken;
      if (!CareerVietClient.fresh(token)) token = await this.refresh();
      if (!CareerVietClient.fresh(token)) throw new AuthError('Đăng nhập xong nhưng không lấy được access token còn hạn');
    }
    this.saveCookies(); // cookie có thể được server gia hạn
    this.token = token;
    this.userId = j?.user?.id ?? this.userId;
  }

  /** Tải file (CV) từ internal-api — trả Response để stream thẳng về Odoo, không lưu lại */
  async fetchFile(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureToken();
      const r = await fetch(API + pathname, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': UA, Origin: SITE, Referer: SITE + '/' },
        signal: AbortSignal.timeout(60_000),
      });
      if (r.status !== 401) return r;
      await r.body?.cancel();
      this.token = undefined;
    }
    throw new AuthError(`${pathname}: 401 sau khi làm mới token`);
  }

  // ---------- internal-api ----------
  async get(pathname: string, params: Record<string, string | number | undefined>, maxRetry = 6): Promise<Json> {
    const url = new URL(API + pathname);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      await this.ensureToken();
      let r: Response | undefined;
      let err = '';
      try {
        r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': UA,
            Accept: 'application/json',
            Origin: SITE,
            Referer: SITE + '/',
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        err = String(e);
      }
      if (r?.status === 200) {
        const j = (await r.json()) as Json;
        await sleep(this.account.delayMs ?? 1000);
        return j;
      }
      if (r?.status === 401) {
        this.log.warn('401 -> làm mới token');
        this.token = undefined;
        continue;
      }
      if (r && [400, 403, 404].includes(r.status)) {
        throw new Error(`${pathname} ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      // 429 / 5xx / lỗi mạng -> backoff
      let wait = Math.min(60, 2 ** attempt) + Math.random();
      const ra = r?.headers.get('retry-after');
      if (ra && /^\d+$/.test(ra)) wait = Math.max(wait, Number(ra));
      await r?.body?.cancel();
      this.log.warn(`[retry] ${pathname} -> ${r?.status ?? err}, đợi ${wait.toFixed(1)}s`);
      await sleep(wait * 1000);
    }
    throw new Error(`${pathname} thất bại sau ${maxRetry} lần`);
  }

  async *paginate(pathname: string, params: Record<string, string | number | undefined>): AsyncGenerator<Json> {
    for (let page = 1; ; page++) {
      const j = await this.get(pathname, { ...params, page, limit: PAGE_SIZE });
      const data: Json[] = j.data ?? [];
      yield* data;
      if (!j.metadata?.hasNextPage || data.length === 0) break;
    }
  }
}
