import path from 'node:path';
import { config, type AccountConfig } from '../../config.js';
import type { JobStatus, NormalizedApplicant, NormalizedJob, SourceConnector } from '../types.js';
import { CareerVietClient } from './client.js';

const SITE = 'https://careerviet.vn';

// action của API -> trạng thái tin (đã kiểm tra trên giao diện HR Central)
const JOB_TABS: [number, JobStatus][] = [
  [1, 'open'],
  [0, 'pending'],
  [2, 'paused'],
  [3, 'expired'],
];

// folder_resume_status bên CareerViet — khớp SOURCE_STATUS của Odoo
const SOURCE_STATUSES = new Set(['0', '1', '2', '3', '4', '5', '6']);

const str = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v) || 0);

/** CareerViet dùng 2 dạng cho cùng 1 ID: số (2312199) và hex (35C83107) */
export const toHexId = (n: number | string) => (Number(n) + 900_000_000).toString(16).toUpperCase();

/** "21-10-2026" -> "2026-10-21" */
function vnDate(v: unknown): string | undefined {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(v ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/** ISO -> 'YYYY-MM-DD HH:MM:SS' UTC cho Odoo */
function odooDatetime(v: unknown): string | undefined {
  const d = v ? new Date(String(v)) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : undefined;
}

function slug(s: string | undefined) {
  return (
    (s ?? 'ho-so')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'ho-so'
  );
}

function expectedSalary(a: Record<string, any>): string | undefined {
  if (a.resume_salary_unit === 'ltt') return 'Thoả thuận';
  const from = Number(a.resume_targetjob_salary) || 0;
  const to = Number(a.resume_targetjob_to_salary) || 0;
  if (!from && !to) return undefined;
  const fmt = (v: number) => (a.resume_salary_unit === 'vnd' ? `${v / 1_000_000}` : v.toLocaleString('en-US'));
  const unit = a.resume_salary_unit === 'vnd' ? 'triệu' : String(a.resume_salary_unit ?? '').toUpperCase();
  return `${[from, to].filter(Boolean).map(fmt).join(' – ')} ${unit}`.trim();
}

export class CareerVietConnector implements SourceConnector {
  private client: CareerVietClient;

  constructor(readonly account: AccountConfig) {
    this.client = new CareerVietClient(account, path.join(config.dataDir, 'cookies', `${account.id}.json`));
  }

  async *fetchJobs(): AsyncIterable<NormalizedJob> {
    await this.client.ensureToken(); // cần user_id
    const windowStart = new Date(Date.now() - config.syncWindowDays * 86_400_000).toISOString().slice(0, 10);
    for (const [action, status] of JOB_TABS) {
      for await (const j of this.client.paginate('/js/emp/jobs', {
        type: 3,
        action,
        date_type: 0,
        order: 'DESC',
        user_id: this.client.userId,
      })) {
        const dateExpire = vnDate(j.job_expiration_date) ?? vnDate(j.job_not_pro_date);
        // Tin hết hạn quá cửa sổ đồng bộ: bỏ (Odoo cũng tự dọn sau cùng số ngày)
        if (status === 'expired' && dateExpire && dateExpire < windowStart) continue;
        const folderRef = str(j.folder_id);
        yield {
          externalId: String(j.job_id),
          title: j.job_title ?? `Job ${j.job_id}`,
          status,
          jobCode: str(j.job_code),
          folderRef,
          datePosted: vnDate(j.job_active_date),
          dateExpire,
          salaryFrom: num(j.job_from_salary),
          salaryTo: num(j.job_to_salary),
          salaryUnit: str(j.job_salary_unit),
          location: str(j.job_location_name_vn ?? j.location_name),
          industry: str(j.job_industry_name_vn ?? j.job_industry_name),
          viewCount: num(j.job_view_num),
          applyCount: Number(j.job_apply_not_delete ?? j.job_apply_num) || 0,
          // Danh sách hồ sơ của tin trên HR Central
          url: folderRef
            ? `${SITE}/vi/employers/hrcentral/manageresume/2/${folderRef}/*/0/0/*/*/7/2/6/2/0/desc/${this.client.userId}/1`
            : undefined,
        };
      }
    }
  }

  async *fetchApplicants(job: NormalizedJob): AsyncIterable<NormalizedApplicant> {
    if (!job.folderRef || !job.applyCount) return; // tin chưa đăng / chưa ai nộp
    for await (const a of this.client.paginate('/es/emp/folder-resumes/folder-apply', {
      folder_id: job.folderRef,
      user_id: this.client.userId,
    })) {
      const status = str(a.folder_resume_status);
      yield {
        externalId: String(a.folder_resume_id),
        resumeRef: str(a.resume_id),
        candidateRef: str(a.jobseeker_id),
        fullName: a.jobseeker_fullname ?? a.job_apply_jobseeker_name ?? 'Ứng viên CareerViet',
        headline: str(a.resume_headline_vn),
        lastJob: str(a.resume_last_job),
        lastCompany: str(a.resume_last_company),
        experienceYears: num(a.resume_year_of_experience),
        degree: str(a.degree_name_vn),
        location: str(a.resume_location_vn)?.trim(),
        expectedSalary: expectedSalary(a),
        matchScore: num(a.job_resume_coincidence),
        appliedAt: odooDatetime(a.created_at),
        sourceStatus: status && SOURCE_STATUSES.has(status) ? status : undefined,
        cvType: a.resume_kind === 0 ? 'online' : a.resume_kind === 2 ? 'file' : 'other',
        seenOnSource: a.folder_resume_viewed === 1,
        // Trang hồ sơ trên HR Central — mở khi đang đăng nhập thì thấy đủ liên hệ (miễn phí với hồ sơ ứng tuyển)
        url: `${SITE}/vi/employers/popup/resumeinfo/${job.folderRef}/${toHexId(a.folder_resume_id)}/${slug(
          a.resume_headline_vn,
        )}/${a.resume_id}.html`,
      };
    }
  }

  /** Email lấy từ chính danh sách hồ sơ ứng tuyển (miễn phí, không đánh dấu "đã xem") */
  async fetchEmails(folders: { folderRef: string; ids: string[] }[]) {
    await this.client.ensureToken();
    const emails: Record<string, string> = {};
    for (const { folderRef, ids } of folders) {
      const wanted = new Set(ids.map(String));
      for await (const a of this.client.paginate('/es/emp/folder-resumes/folder-apply', {
        folder_id: folderRef,
        user_id: this.client.userId,
      })) {
        const id = String(a.folder_resume_id);
        if (wanted.has(id) && a.jobseeker_email) {
          emails[id] = a.jobseeker_email;
          wanted.delete(id);
        }
        if (!wanted.size) break;
      }
    }
    return emails;
  }

  /** CV đính kèm: file gốc ứng viên upload. CV online: PDF CareerViet tự xuất (giống nút "Tải CV"). */
  async fetchCv({ resumeRef, candidateRef, cvType }: { resumeRef: string; candidateRef?: string; cvType?: string }) {
    const id = encodeURIComponent(resumeRef);
    if (cvType === 'file' && candidateRef) {
      const r = await this.client.fetchFile(`/jss/emp/resumes/${id}/view-file/${encodeURIComponent(candidateRef)}`);
      if (r.ok) return r;
      await r.body?.cancel();
    }
    return this.client.fetchFile(`/jss/emp/resumes/${id}/export-pdf`, 'POST');
  }

  submitOtp(code: string) {
    return this.client.submitOtp(code);
  }

  resetAuth() {
    this.client.resetAuth();
  }
}
