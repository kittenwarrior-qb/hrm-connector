import type { AccountConfig } from '../config.js';
import { logger } from '../logger.js';
import type { NormalizedApplicant, NormalizedJob } from '../sources/types.js';
import type { OdooClient } from './client.js';

const log = logger('odoo');

/**
 * Ghi vào bảng chờ của module Odoo satori_recruitment_jobboard.
 * Odoo tự upsert theo (nguồn, tài khoản, mã tin) / (tin, mã hồ sơ) và KHÔNG
 * ghi đè việc HR đã làm (phiếu gắn với tin, hồ sơ đã đẩy / bỏ qua).
 * Ứng viên thật (hr.applicant) chỉ được tạo khi HR bấm "Đẩy thành ứng viên".
 */
export class JobboardSink {
  constructor(private odoo: OdooClient) {}

  /** Trả {mã tin: id satori.jobboard.posting} */
  async upsertPostings(acc: AccountConfig, jobs: NormalizedJob[]) {
    const rows = jobs.map((j) => ({
      external_id: j.externalId,
      name: j.title,
      status: j.status,
      job_code: j.jobCode ?? false,
      folder_ref: j.folderRef ?? false,
      date_posted: j.datePosted ?? false,
      date_expire: j.dateExpire ?? false,
      salary_from: j.salaryFrom ?? 0,
      salary_to: j.salaryTo ?? 0,
      salary_unit: j.salaryUnit ?? false,
      location: j.location ?? false,
      industry: j.industry ?? false,
      view_count: j.viewCount ?? 0,
      apply_count: j.applyCount,
      external_url: j.url ?? false,
    }));
    const ids = await this.odoo.call<Record<string, number>>('satori.jobboard.posting', 'jobboard_sync_postings', [
      acc.source,
      acc.id,
      rows,
    ]);
    log.info(`${acc.id}: ${jobs.length} tin đăng`);
    return new Map(Object.entries(ids));
  }

  async upsertApplications(postingId: number, apps: NormalizedApplicant[]) {
    if (!apps.length) return { created: 0, updated: 0 };
    const rows = apps.map((a) => ({
      external_id: a.externalId,
      resume_ref: a.resumeRef ?? false,
      candidate_ref: a.candidateRef ?? false,
      name: a.fullName,
      headline: a.headline ?? false,
      last_job: a.lastJob ?? false,
      last_company: a.lastCompany ?? false,
      experience_years: a.experienceYears ?? 0,
      degree: a.degree ?? false,
      location: a.location ?? false,
      expected_salary: a.expectedSalary ?? false,
      match_score: a.matchScore ?? 0,
      applied_at: a.appliedAt ?? false,
      source_status: a.sourceStatus ?? false,
      cv_type: a.cvType ?? false,
      seen_on_source: a.seenOnSource ?? false,
      external_url: a.url ?? false,
    }));
    return this.odoo.call<{ created: number; updated: number }>(
      'satori.jobboard.application',
      'jobboard_sync_applications',
      [postingId, rows],
    );
  }
}
