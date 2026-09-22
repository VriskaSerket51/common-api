import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { initializeScheduler, shutdownScheduler, logger } from '@ireves/common-api';

after(async () => { await shutdownScheduler(); logger.flush(); });

test('timer uses the scheduled date and canceled handles cannot execute', { timeout: 5000 }, async () => {
  const called = Promise.withResolvers();
  let count = 0;
  const [job] = initializeScheduler([{ name: 'clock', cron: '* * * * * *',
    job: context => { count++; called.resolve(context); },
  }]);
  const expected = job.nextInvocation();
  try {
    const context = await called.promise;
    assert.equal(context.scheduledAt.getTime(), expected.getTime());
    job.cancel();
    assert.equal(job.nextInvocation(), null);
    await job.invoke();
    assert.equal(count, 1);
    assert.equal('reschedule' in job, false);
  } finally { await shutdownScheduler(); }
});

test('manual failures reject and shutdown makes old handles inert', async () => {
  const failure = new Error('manual failure');
  const log = mock.method(logger, 'error', () => {});
  const [job] = initializeScheduler([{ name: 'manual', cron: '0 0 1 1 *', job: () => { throw failure; } }]);
  try {
    await assert.rejects(job.invoke(), error => error === failure);
    assert.equal(log.mock.callCount(), 1);
    await shutdownScheduler();
    await job.invoke();
    assert.equal(log.mock.callCount(), 1);
  } finally { await shutdownScheduler(); log.mock.restore(); }
});

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

test('timer failures are logged without an unhandled rejection', { timeout: 5000 }, async () => {
  const failure = new Error('scheduled failure');
  const reported = Promise.withResolvers();
  const log = mock.method(logger, 'error', (record) => { reported.resolve(record); });
  try {
    const [job] = initializeScheduler([{ name: 'failure', cron: '* * * * * *', job: async () => { throw failure; } }]);
    assert.equal((await reported.promise).error, failure);
    job.cancel();
    assert.equal(log.mock.callCount(), 1);
  } finally { await shutdownScheduler(); log.mock.restore(); }
});

test('invalid batches roll back registered jobs and duplicate names are rejected', async () => {
  assert.throws(() => initializeScheduler([
    { name: 'valid', cron: '0 0 1 1 *', job() {} },
    { name: 'invalid', cron: 'not a cron', job() {} },
  ]), /Invalid cron/);
  const [retried] = initializeScheduler([{ name: 'valid', cron: '0 0 1 1 *', job() {} }]);
  assert.equal(retried.name, 'valid');
  initializeScheduler([{ name: 'unique', cron: '0 0 1 1 *', job() {} }]);
  assert.throws(() => initializeScheduler([{ name: 'unique', cron: '* * * * *', job() {} }]), /unique/);
  await shutdownScheduler();
});
