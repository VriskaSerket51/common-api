import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { once } from 'node:events';
import scheduler from 'node-schedule';
import { initializeScheduler, shutdownScheduler, logger } from '@ireves/common-api';

after(async () => { await shutdownScheduler(); logger.close(); });

test('scheduler awaits asynchronous jobs and preserves scheduled dates', async () => {
  const pending = Promise.withResolvers();
  const [job] = initializeScheduler([{ name: 'pending', cron: '0 0 1 1 *', job: () => pending.promise }]);
  const date = new Date(Date.now() - 2000);
  const timestamp = date.getTime();
  const log = mock.method(logger, 'info', () => logger);
  try {
    const execution = job.invoke(date);
    assert.ok(execution instanceof Promise);
    assert.equal(date.getTime(), timestamp);
    assert.match(log.mock.calls[0].arguments[0], new RegExp(date.toISOString().replace(/[.]/g, '\\.')));
    let stopped = false;
    const shutdown = shutdownScheduler().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    pending.resolve();
    await Promise.all([execution, shutdown]);
    assert.equal(stopped, true);
  } finally { pending.resolve(); log.mock.restore(); await shutdownScheduler(); }
});

test('rejected scheduled jobs emit an error and are handled without crashing', { timeout: 5000 }, async () => {
  const failure = new Error('scheduled failure');
  const log = mock.method(logger, 'error', () => logger);
  try {
    const [job] = initializeScheduler([{ name: 'failure', cron: '0 0 1 1 *', job: async () => { throw failure; } }]);
    const error = once(job, 'error');
    job.reschedule(new Date(Date.now() + 100));
    assert.equal((await error)[0], failure);
    assert.equal(log.mock.callCount(), 1);
  } finally { await shutdownScheduler(); log.mock.restore(); }
});

test('invalid batches roll back registered jobs and duplicate names are rejected', async () => {
  assert.throws(() => initializeScheduler([
    { name: 'valid', cron: '0 0 1 1 *', job() {} },
    { name: 'invalid', cron: 'not a cron', job() {} },
  ]), /Invalid cron/);
  assert.equal(scheduler.scheduledJobs.valid, undefined);
  initializeScheduler([{ name: 'unique', cron: '0 0 1 1 *', job() {} }]);
  assert.throws(() => initializeScheduler([{ name: 'unique', cron: '* * * * *', job() {} }]), /unique/);
  await shutdownScheduler();
});
