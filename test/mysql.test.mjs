import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import mysql from 'mysql2/promise';
import {
  initializeConfig, getAllAsync, getFirstAsync, runAsync, withTransaction,
  closeDatabase, MySqlException, logger,
} from '@ireves/common-api';

initializeConfig({ jwtSecret: 'database-test-secret', db: {
  host: 'localhost', port: 3306, user: 'test', password: '', database: 'test', connectionLimit: 3,
} });
after(() => logger.close());

test('helpers reuse a pool, preserve bindings, and wrap driver failures', async () => {
  const calls = [];
  const error = new Error('driver failed');
  const fakePool = {
    async execute(sql, values) {
      calls.push([sql, values]);
      if (sql === 'fail') throw error;
      return [sql === 'empty' ? [] : sql === 'update' ? { affectedRows: 1 } : [{ id: 1 }], []];
    },
    async end() { calls.push('end'); },
  };
  const factory = mock.method(mysql, 'createPool', () => fakePool);
  try {
    assert.deepEqual(await getAllAsync('select', [123]), [{ id: 1 }]);
    assert.deepEqual(await getFirstAsync('select'), { id: 1 });
    assert.equal(await getFirstAsync('empty'), null);
    assert.deepEqual(await runAsync('update'), { affectedRows: 1 });
    await assert.rejects(getAllAsync('fail'), failure => failure instanceof MySqlException && failure.error === error);
    assert.equal(factory.mock.callCount(), 1);
    assert.equal(factory.mock.calls[0].arguments[0].connectionLimit, 3);
    assert.deepEqual(calls[0], ['select', [123]]);
    await closeDatabase();
    assert.equal(calls.at(-1), 'end');
  } finally { await closeDatabase(); factory.mock.restore(); }
});

test('transactions commit or roll back and release or discard connections', async () => {
  const calls = [];
  let rollbackFails = false;
  let commitFails = false;
  const conn = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); if (commitFails) throw new Error('commit failed'); },
    async rollback() { calls.push('rollback'); if (rollbackFails) throw new Error('rollback failed'); },
    release() { calls.push('release'); },
    destroy() { calls.push('destroy'); },
  };
  const factory = mock.method(mysql, 'createPool', () => ({
    async getConnection() { return conn; }, async end() {},
  }));
  try {
    assert.equal(await withTransaction(async connection => { assert.equal(connection, conn); return 42; }), 42);
    assert.deepEqual(calls.splice(0), ['begin', 'commit', 'release']);
    const failure = new Error('application failed');
    await assert.rejects(withTransaction(async () => { throw failure; }), error => error === failure);
    assert.deepEqual(calls.splice(0), ['begin', 'rollback', 'release']);
    commitFails = true;
    await assert.rejects(withTransaction(async () => 42), /commit failed/);
    assert.deepEqual(calls.splice(0), ['begin', 'commit', 'rollback', 'release']);
    rollbackFails = true;
    await assert.rejects(withTransaction(async () => { throw failure; }), error =>
      error instanceof AggregateError && error.errors[0] === failure);
    assert.deepEqual(calls, ['begin', 'rollback', 'destroy']);
  } finally { await closeDatabase(); factory.mock.restore(); }
});

test('pool closure blocks new work and configuration changes require closing the old pool', async () => {
  const pending = Promise.withResolvers();
  let delayed = true;
  const factory = mock.method(mysql, 'createPool', () => ({
    async execute() { return [[], []]; },
    end() { return delayed ? pending.promise : Promise.resolve(); },
  }));
  try {
    await getAllAsync('select');
    initializeConfig({ jwtSecret: 'new-test-secret', db: {
      host: 'localhost', port: 3306, user: 'test', password: '', database: 'new_database',
    } });
    await assert.rejects(getAllAsync('select'), /closeDatabase/);
    const closing = closeDatabase();
    assert.equal(closeDatabase(), closing);
    await assert.rejects(getAllAsync('select'), /closing/);
    pending.resolve();
    await closing;
    delayed = false;
    await getAllAsync('select');
    assert.equal(factory.mock.callCount(), 2);
    assert.equal(factory.mock.calls[1].arguments[0].database, 'new_database');
  } finally { pending.resolve(); await closeDatabase(); factory.mock.restore(); }
});
