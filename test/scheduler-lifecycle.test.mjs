import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App, createRuntime, createScheduler, createLogger } from '@ireves/common-api';

test('separate schedulers allow identical names and skip overlaps by default', async () => {
  const log = createLogger({ silent: true });
  const a = createScheduler(log), b = createScheduler(log);
  const gate = Promise.withResolvers();
  let count = 0;
  const [first] = a.initialize([{ name: 'same', cron: '0 0 1 1 *', job: () => { count++; return gate.promise; } }]);
  const [second] = b.initialize([{ name: 'same', cron: '0 0 1 1 *', job: () => { count++; } }]);
  try {
    const pending = first.invoke(new Date());
    await first.invoke(new Date());
    assert.equal(count, 1);
    await second.invoke(new Date());
    assert.equal(count, 2);
    gate.resolve();
    await pending;
  } finally { gate.resolve(); await Promise.all([a.shutdown(), b.shutdown()]); log.close(); }
});

test('allow overlap runs both invocations and shutdown signals both', async () => {
  const log = createLogger({ silent: true });
  const scheduler = createScheduler(log);
  const signals = [];
  const [job] = scheduler.initialize([{ name: 'parallel', cron: '0 0 1 1 *', overlap: 'allow',
    job: ({ signal }) => new Promise(resolve => {
      signals.push(signal);
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    }),
  }]);
  try {
    const pending = [job.invoke(new Date()), job.invoke(new Date())];
    await Promise.resolve();
    await scheduler.shutdown({ timeoutMs: 1000 });
    await Promise.all(pending);
    assert.equal(signals.length, 2);
    assert.ok(signals.every(signal => signal.aborted));
  } finally { await scheduler.shutdown(); log.close(); }
});

test('non-cooperative job times out without pretending it stopped or closing its database', async () => {
  const runtime = createRuntime({ logging: { silent: true } });
  const app = await App.create({ runtime });
  const gate = Promise.withResolvers();
  const [job] = runtime.scheduler.initialize([{ name: 'stuck', cron: '0 0 1 1 *', job: () => gate.promise }]);
  let databaseClosed = false;
  runtime.database.closeDatabase = async () => { databaseClosed = true; };
  const running = job.invoke(new Date());
  try {
    await assert.rejects(app.shutdown({ timeoutMs: 20 }), error =>
      error instanceof AggregateError && error.errors.some(item => /timed out/.test(item.message)));
    assert.equal(databaseClosed, false);
    assert.throws(() => runtime.scheduler.initialize([]), /shutting down/);
    gate.resolve();
    await running;
    await app.shutdown();
    assert.equal(databaseClosed, true);
  } finally { gate.resolve(); await runtime.scheduler.shutdown(); runtime.logger.close(); }
});
