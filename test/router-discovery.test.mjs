import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, readAllFilesAsync } from '@ireves/common-api';

test('asynchronous discovery sorts nested paths and routes follow that precedence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'common-api-order-'));
  const entry = new URL('../dist/index.js', import.meta.url).href;
  let app;
  try {
    await mkdir(path.join(directory, 'a'));
    const module = label => `import { RouterBase } from ${JSON.stringify(entry)};
      export default class extends RouterBase {
        path = '/';
        models = [{ method: 'get', path: '/', controller: (_req, res) => res.send(${JSON.stringify(label)}) }];
      }`;
    // Creation order intentionally differs from path order, including a nested route.
    await writeFile(path.join(directory, 'z.mjs'), module('last'));
    await writeFile(path.join(directory, 'a', 'route.mjs'), module('first'));
    await writeFile(path.join(directory, 'a.mjs'), module('middle'));
    await writeFile(path.join(directory, 'ignored.d.ts'), 'throw new Error("must not import");');
    const files = await readAllFilesAsync(directory, name => name.endsWith('.mjs'));
    assert.deepEqual(files.map(file => path.relative(directory, file).split(path.sep).join('/')),
      ['a.mjs', 'a/route.mjs', 'z.mjs']);
    app = await App.create({ routerDir: directory });
    const server = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await response.text(), 'middle');
    await assert.rejects(readAllFilesAsync(path.join(directory, 'missing')), { code: 'ENOENT' });
  } finally {
    await app?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
