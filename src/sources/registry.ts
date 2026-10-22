import type { AccountConfig } from '../config.js';
import { CareerVietConnector } from './careerviet/connector.js';
import type { SourceConnector } from './types.js';

// Thêm nguồn mới (TopCV, VietnamWorks, ...): viết connector implement SourceConnector rồi đăng ký ở đây.
export function createConnector(account: AccountConfig): SourceConnector {
  switch (account.source) {
    case 'careerviet':
      return new CareerVietConnector(account);
  }
}
