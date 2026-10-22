import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Thiếu biến môi trường ${name} trong .env`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  apiKey: required('API_KEY'),
  accountsFile: path.resolve(process.env.ACCOUNTS_FILE ?? 'accounts.json'),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  syncCron: process.env.SYNC_CRON?.trim() ?? '',
  // VPS thường để giờ UTC — lịch "7h-21h" phải hiểu theo giờ Việt Nam
  syncTimezone: process.env.SYNC_TZ?.trim() || 'Asia/Ho_Chi_Minh',
  syncOnStart: process.env.SYNC_ON_START === 'true',
  // Tin hết hạn quá số ngày này thì không đồng bộ nữa (Odoo dọn theo cùng ngưỡng)
  syncWindowDays: Number(process.env.SYNC_WINDOW_DAYS ?? 90),
  odoo: {
    url: required('ODOO_URL').replace(/\/+$/, ''),
    db: required('ODOO_DB'),
    username: required('ODOO_USERNAME'),
    apiKey: required('ODOO_API_KEY'),
  },
};

export type SourceType = 'careerviet';

export interface AccountConfig {
  /** Định danh ổn định, dùng trong External ID của Odoo — đổi id sẽ sinh bản ghi mới */
  id: string;
  source: SourceType;
  label?: string;
  enabled?: boolean;
  username?: string;
  password?: string;
  /** Cookie copy từ trình duyệt, dùng khi chưa có phiên đã lưu */
  cookie?: string;
  delayMs?: number;
}

const SOURCES: SourceType[] = ['careerviet'];

export function loadAccounts(): AccountConfig[] {
  if (!fs.existsSync(config.accountsFile)) {
    throw new Error(`Không tìm thấy ${config.accountsFile} (copy từ accounts.example.json)`);
  }
  const list = JSON.parse(fs.readFileSync(config.accountsFile, 'utf8')) as AccountConfig[];
  if (!Array.isArray(list)) throw new Error('accounts.json phải là một mảng');

  const seen = new Set<string>();
  for (const a of list) {
    if (!/^[a-z0-9_]+$/.test(a.id ?? '')) {
      throw new Error(`Account id "${a.id}" không hợp lệ (chỉ a-z, 0-9, _)`);
    }
    if (seen.has(a.id)) throw new Error(`Account id "${a.id}" bị trùng`);
    if (!SOURCES.includes(a.source)) throw new Error(`Account ${a.id}: source "${a.source}" chưa hỗ trợ`);
    seen.add(a.id);
  }
  return list.filter((a) => a.enabled !== false);
}
