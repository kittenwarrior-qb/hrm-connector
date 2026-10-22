import type { AccountConfig } from '../config.js';
import { logger } from '../logger.js';
import type { JobboardSink } from '../odoo/jobboard.js';
import { createConnector } from '../sources/registry.js';
import { OtpRequiredError, type NormalizedApplicant, type NormalizedJob, type SourceConnector } from '../sources/types.js';

const log = logger('sync');

export type SyncStatus = 'idle' | 'running' | 'ok' | 'error' | 'otp_required';

export interface SyncStats {
  jobs: number;
  applicantsSeen: number;
  applicantsCreated: number;
  jobErrors: number;
}

export interface AccountState {
  id: string;
  source: string;
  label?: string;
  status: SyncStatus;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastStats?: SyncStats;
}

export class AccountNotFoundError extends Error {}

/** Trạng thái chỉ giữ trong RAM — dữ liệu thật nằm ở Odoo */
export class SyncEngine {
  private entries = new Map<string, { connector: SourceConnector; state: AccountState }>();

  constructor(
    accounts: AccountConfig[],
    private sink: JobboardSink,
  ) {
    for (const a of accounts) {
      this.entries.set(a.id, {
        connector: createConnector(a),
        state: { id: a.id, source: a.source, label: a.label, status: 'idle' },
      });
    }
  }

  private entry(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new AccountNotFoundError(`Không có account "${id}"`);
    return e;
  }

  list() {
    return [...this.entries.values()].map((e) => e.state);
  }

  get(id: string) {
    return this.entry(id).state;
  }

  isRunning(id: string) {
    return this.entry(id).state.status === 'running';
  }

  async submitOtp(id: string, code: string) {
    const { connector } = this.entry(id);
    if (!connector.submitOtp) throw new Error('Nguồn này không hỗ trợ OTP');
    await connector.submitOtp(code);
  }

  resetAuth(id: string) {
    this.entry(id).connector.resetAuth?.();
  }

  async fetchCv(id: string, ref: { resumeRef: string; candidateRef?: string; cvType?: string }) {
    const { connector } = this.entry(id);
    if (!connector.fetchCv) throw new Error('Nguồn này không hỗ trợ tải CV');
    return connector.fetchCv(ref);
  }

  async fetchEmails(id: string, folders: { folderRef: string; ids: string[] }[]) {
    const { connector } = this.entry(id);
    if (!connector.fetchEmails) throw new Error('Nguồn này không hỗ trợ lấy email');
    return connector.fetchEmails(folders);
  }

  /** Sync 1 account. Bỏ qua nếu account đó đang chạy. */
  async syncAccount(id: string): Promise<AccountState> {
    const { connector, state } = this.entry(id);
    if (state.status === 'running') return state;

    const acc = connector.account;
    state.status = 'running';
    state.lastStartedAt = new Date().toISOString();
    state.lastError = undefined;
    const stats: SyncStats = { jobs: 0, applicantsSeen: 0, applicantsCreated: 0, jobErrors: 0 };
    log.info(`${id}: bắt đầu`);

    try {
      const jobs: NormalizedJob[] = [];
      for await (const j of connector.fetchJobs()) jobs.push(j);
      stats.jobs = jobs.length;
      const postingIds = await this.sink.upsertPostings(acc, jobs);

      for (const job of jobs) {
        try {
          const apps: NormalizedApplicant[] = [];
          for await (const a of connector.fetchApplicants(job)) apps.push(a);
          const r = await this.sink.upsertApplications(postingIds.get(job.externalId)!, apps);
          stats.applicantsSeen += apps.length;
          stats.applicantsCreated += r.created;
          if (r.created) log.info(`${id}: "${job.title}" +${r.created} ứng viên`);
        } catch (e) {
          if (e instanceof OtpRequiredError) throw e;
          // Lỗi 1 job không chặn các job còn lại
          stats.jobErrors++;
          log.error(`${id}: lỗi job "${job.title}" (#${job.externalId}):`, (e as Error).message);
        }
      }

      state.status = 'ok';
      state.lastSuccessAt = new Date().toISOString();
      log.info(`${id}: xong`, stats);
    } catch (e) {
      state.status = e instanceof OtpRequiredError ? 'otp_required' : 'error';
      state.lastError = (e as Error).message;
      log.error(`${id}: ${state.lastError}`);
    } finally {
      state.lastFinishedAt = new Date().toISOString();
      state.lastStats = stats;
    }
    return state;
  }

  /** Sync lần lượt từng account (tuần tự để không dồn request) */
  async syncAll() {
    for (const id of this.entries.keys()) await this.syncAccount(id);
  }
}
