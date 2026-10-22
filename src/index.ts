import cron from 'node-cron';
import { config, loadAccounts } from './config.js';
import { logger } from './logger.js';
import { OdooClient } from './odoo/client.js';
import { JobboardSink } from './odoo/jobboard.js';
import { createServer } from './server.js';
import { SyncEngine } from './sync/engine.js';

const log = logger('main');

const accounts = loadAccounts();
const odoo = new OdooClient(config.odoo);
const sink = new JobboardSink(odoo);
const engine = new SyncEngine(accounts, sink);

const server = createServer(engine, odoo, config.apiKey).listen(config.port, () => {
  log.info(`listening on :${config.port}, ${accounts.length} account: ${accounts.map((a) => a.id).join(', ')}`);
});

if (config.syncCron) {
  if (!cron.validate(config.syncCron)) throw new Error(`SYNC_CRON không hợp lệ: ${config.syncCron}`);
  cron.schedule(config.syncCron, () => void engine.syncAll(), { timezone: config.syncTimezone });
  log.info(`lịch sync: ${config.syncCron} (${config.syncTimezone})`);
}
if (config.syncOnStart) void engine.syncAll();

// PM2 gửi SIGINT khi restart/stop
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} -> dừng`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
