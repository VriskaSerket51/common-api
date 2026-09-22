import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '@ireves/common-api';

// Explicit invocation must fail, not silently skip, if integration infrastructure is missing.
const host = process.env.MYSQL_TEST_HOST;
const database = process.env.MYSQL_TEST_DATABASE;
if (!host || !database?.startsWith('common_api_test')) {
  throw new Error('Set MYSQL_TEST_HOST and MYSQL_TEST_DATABASE (prefix common_api_test) to run integration tests.');
}

test('real MySQL pool, commit, rollback and killed-connection recovery', { timeout: 30_000 }, async () => {
  const db = createDatabase({
    host, database, port: Number(process.env.MYSQL_TEST_PORT ?? 3306),
    user: process.env.MYSQL_TEST_USER ?? 'root',
    password: process.env.MYSQL_TEST_PASSWORD ?? '', connectionLimit: 2,
  });
  const table = 'integration_' + randomBytes(6).toString('hex');
  let created = false;
  try {
    await db.runAsync(`CREATE TABLE ${table} (id INT PRIMARY KEY, balance INT NOT NULL) ENGINE=InnoDB`);
    created = true;
    await db.runAsync(`INSERT INTO ${table} VALUES (?, ?), (?, ?)`, [1, 100, 2, 100]);
    await db.withTransaction(async conn => {
      await conn.execute(`UPDATE ${table} SET balance = balance - ? WHERE id = ?`, [10, 1]);
      await conn.execute(`UPDATE ${table} SET balance = balance + ? WHERE id = ?`, [10, 2]);
    });
    assert.deepEqual(await db.getAllAsync(`SELECT balance FROM ${table} ORDER BY id`), [{ balance: 90 }, { balance: 110 }]);
    await assert.rejects(db.withTransaction(async conn => {
      await conn.execute(`UPDATE ${table} SET balance = 0`);
      throw new Error('rollback requested');
    }), /rollback requested/);
    assert.equal((await db.getFirstAsync(`SELECT SUM(balance) AS total FROM ${table}`)).total, '200');

    const results = await Promise.all(Array.from({ length: 8 }, () => db.getFirstAsync('SELECT CONNECTION_ID() AS id')));
    assert.ok(new Set(results.map(row => row.id)).size <= 2);

    const admin = await db.connection();
    try {
      await assert.rejects(db.withTransaction(async conn => {
        conn.on('error', () => {});
        await admin.query('KILL CONNECTION ?', [conn.threadId]);
        await conn.query('SELECT 1');
      }));
    } finally { await admin.end(); }
    assert.equal((await db.getFirstAsync('SELECT 1 AS healthy')).healthy, 1);
  } finally {
    try { if (created) await db.runAsync(`DROP TABLE ${table}`); }
    finally { await db.closeDatabase({ timeoutMs: 5000 }); }
  }
});
