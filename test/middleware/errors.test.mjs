import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App, HttpException, createLogger, createRuntime } from '@ireves/common-api';

test('application subclasses map public codes without exposing arbitrary properties', async () => {
  class DuplicateEmail extends HttpException {
    constructor() {
      super(409, { code: 'EMAIL_TAKEN', message: 'Email is already in use.' });
      this.privateDetails = 'do not expose';
    }
  }
  const records = [];
  const app = await App.create({ runtime: createRuntime({ logger: createLogger({
    destination: { write: line => records.push(JSON.parse(line)) },
  }) }), routers: [{ path: '/', models: [{ method: 'get', path: '/', controller: () => { throw new DuplicateEmail(); } }] }] });
  try {
    const server = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: { code: 'EMAIL_TAKEN', message: 'Email is already in use.' },
      requestId: response.headers.get('x-request-id'),
    });
    assert.deepEqual(records, []);
  } finally { await app.shutdown(); }
});

test('explicit server errors are logged with cause while private messages stay hidden', async () => {
  const records = [];
  const cause = new Error('private database address');
  const failure = new HttpException(503, { code: 'UNAVAILABLE', message: 'private connection details', cause });
  const log = createLogger({ destination: { write: line => records.push(JSON.parse(line)) } });
  const app = await App.create({ runtime: createRuntime({ logger: log }), routers: [{ path: '/', models: [
    { method: 'get', path: '/', controller: () => { throw failure; } },
    { method: 'get', path: '/public', controller: () => {
      throw new HttpException(503, { message: 'Please retry later.', expose: true });
    } },
    { method: 'get', path: '/unknown', controller: () => { throw cause; } },
    { method: 'post', path: '/json', controller: (_req, res) => res.end() },
  ] }] });
  try {
    const server = await app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body.error, { code: 'UNAVAILABLE', message: 'Service Unavailable' });
    assert.equal(records[0].requestId, body.requestId);
    assert.equal(records[0].error.cause.message, cause.message);
    assert.equal(records[0].error.message, failure.message);
    const publicResponse = await fetch(base + '/public');
    assert.equal((await publicResponse.json()).error.message, 'Please retry later.');
    const unknown = await fetch(base + '/unknown');
    assert.equal(unknown.status, 500);
    assert.deepEqual((await unknown.json()).error, { code: 'HTTP_500', message: 'Internal Server Error' });
    const malformed = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{secret' });
    assert.equal(malformed.status, 400);
    assert.deepEqual((await malformed.json()).error, { code: 'HTTP_400', message: 'Bad Request' });
    assert.equal(records.length, 3);
  } finally { await app.shutdown(); }
});

test('applications can completely replace error mapping without inheriting HttpException', async () => {
  class DomainError extends Error {}
  const app = await App.create({ routers: [{ path: '/', models: [{
    method: 'get', path: '/', controller: () => { throw new DomainError(); },
  }] }], errorHandlers: [(error, _req, res, next) => {
    if (error instanceof DomainError) res.status(422).json({ custom: true });
    else next(error);
  }] });
  try {
    const server = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { custom: true });
  } finally { await app.shutdown(); }
});

test('HTTP exception status is validated and subclass names and causes are preserved', () => {
  for (const status of [200, 399, 600, 400.5, NaN]) assert.throws(() => new HttpException(status), RangeError);
  class CustomError extends HttpException {}
  const cause = new Error('root');
  const error = new CustomError(400, { code: 0, cause });
  assert.equal(error.code, 0);
  assert.equal(error.name, 'CustomError');
  assert.equal(error.cause, cause);
  assert.equal(error.message, 'Bad Request');
});
