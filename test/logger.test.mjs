import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import winston from 'winston';
import { App, createRuntime, createLogger, MySqlException, serializeError } from '@ireves/common-api';

test('structured request logs retain stack, cause and request ID', async () => {
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const log = createLogger({ transports: [new winston.transports.Stream({ stream })] });
  const runtime = createRuntime({ logger: log });
  const cause = new Error('driver failure');
  const app = await App.create({ runtime, routers: [{ path: '/', models: [{
    method: 'get', path: '/', controller: () => { throw new MySqlException(cause); },
  }] }] });
  try {
    const server = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.status, 500);
    const finished = once(log, 'finish'); log.end(); await finished;
    const record = JSON.parse(lines.join('').trim());
    assert.equal(record.requestId, response.headers.get('x-request-id'));
    assert.equal(record.error.name, 'MySqlException');
    assert.equal(record.error.cause.message, 'driver failure');
    assert.match(record.error.stack, /MySqlException/);
    assert.equal(record.method, 'GET');
  } finally { await app.close(); log.close(); }
});

test('circular error causes are serializable', () => {
  const error = new Error('circular'); error.cause = error;
  assert.equal(serializeError(error).cause, '[Circular error]');
});
