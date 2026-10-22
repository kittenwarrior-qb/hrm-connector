import type { AccountConfig } from '../config.js';

export type JobStatus = 'open' | 'pending' | 'paused' | 'expired';

/** Tin tuyển dụng đã chuẩn hoá — key trùng tên field của satori.jobboard.posting */
export interface NormalizedJob {
  externalId: string;
  title: string;
  status: JobStatus;
  jobCode?: string;
  /** Mã thư mục hồ sơ bên nguồn — dùng lại khi lấy hồ sơ / email */
  folderRef?: string;
  datePosted?: string; // YYYY-MM-DD
  dateExpire?: string; // YYYY-MM-DD
  salaryFrom?: number;
  salaryTo?: number;
  salaryUnit?: string;
  location?: string;
  industry?: string;
  viewCount?: number;
  applyCount: number;
  url?: string;
}

/** Hồ sơ ứng tuyển đã chuẩn hoá — cố ý KHÔNG có email/SĐT (xem fetchEmails) */
export interface NormalizedApplicant {
  externalId: string;
  resumeRef?: string;
  candidateRef?: string;
  fullName: string;
  headline?: string;
  lastJob?: string;
  lastCompany?: string;
  experienceYears?: number;
  degree?: string;
  location?: string;
  expectedSalary?: string;
  matchScore?: number;
  appliedAt?: string; // 'YYYY-MM-DD HH:MM:SS' UTC
  sourceStatus?: string;
  cvType?: 'online' | 'file' | 'other';
  seenOnSource?: boolean;
  url?: string;
}

export interface SourceConnector {
  readonly account: AccountConfig;
  fetchJobs(): AsyncIterable<NormalizedJob>;
  fetchApplicants(job: NormalizedJob): AsyncIterable<NormalizedApplicant>;
  /** Email của các hồ sơ (theo thư mục) — Odoo gọi lúc HR đẩy hồ sơ thành ứng viên */
  fetchEmails?(folders: { folderRef: string; ids: string[] }[]): Promise<Record<string, string>>;
  /** File CV (PDF) của 1 hồ sơ — stream thẳng, không lưu */
  fetchCv?(ref: { resumeRef: string; candidateRef?: string; cvType?: string }): Promise<Response>;
  /** Hoàn tất đăng nhập 2 lớp */
  submitOtp?(code: string): Promise<void>;
  /** Bỏ phiên hiện tại, lần sync sau đăng nhập lại từ đầu */
  resetAuth?(): void;
}

export class AuthError extends Error {
  override name = 'AuthError';
}

export class OtpRequiredError extends Error {
  override name = 'OtpRequiredError';
  constructor(public mfaType: string) {
    super(`Cần mã OTP (${mfaType}) — gửi qua POST /api/accounts/:id/otp`);
  }
}
