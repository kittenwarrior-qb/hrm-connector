export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  apiKey: string;
}

export class OdooError extends Error {
  override name = 'OdooError';
}

/** Client External API của Odoo qua /jsonrpc (Odoo 14 → 18; dùng API key thay mật khẩu) */
export class OdooClient {
  private uid?: number;
  private seq = 0;

  constructor(private cfg: OdooConfig) {}

  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const res = await fetch(`${this.cfg.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: ++this.seq, params: { service, method, args } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new OdooError(`Odoo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { result?: T; error?: { message: string; data?: { message?: string } } };
    if (j.error) throw new OdooError(j.error.data?.message ?? j.error.message);
    return j.result as T;
  }

  async version() {
    return this.rpc<{ server_version: string }>('common', 'version', []);
  }

  async authenticate() {
    const uid = await this.rpc<number | false>('common', 'authenticate', [
      this.cfg.db,
      this.cfg.username,
      this.cfg.apiKey,
      {},
    ]);
    if (!uid) throw new OdooError('Đăng nhập Odoo thất bại (kiểm tra ODOO_DB / ODOO_USERNAME / ODOO_API_KEY)');
    this.uid = uid;
    return uid;
  }

  async call<T = unknown>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}) {
    if (!this.uid) await this.authenticate();
    return this.rpc<T>('object', 'execute_kw', [this.cfg.db, this.uid, this.cfg.apiKey, model, method, args, kwargs]);
  }

  searchRead<T = Record<string, any>>(model: string, domain: unknown[], fields: string[], limit?: number) {
    return this.call<T[]>(model, 'search_read', [domain], { fields, ...(limit ? { limit } : {}) });
  }

  create(model: string, vals: Record<string, unknown>) {
    return this.call<number>(model, 'create', [vals]);
  }

  write(model: string, ids: number[], vals: Record<string, unknown>) {
    return this.call<boolean>(model, 'write', [ids, vals]);
  }
}
