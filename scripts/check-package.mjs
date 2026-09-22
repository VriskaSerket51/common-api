import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const directory = mkdtempSync(path.join(tmpdir(), 'common-api-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package.');
const npm = args => execFileSync(process.execPath, [npmCli, ...args], {
  cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
});
try {
  // Runs prepack, so the package is checked against a fresh verified build.
  const raw = npm(['pack', '--json', '--pack-destination', directory, '--cache', path.join(directory, 'cache')]);
  // npm may forward lifecycle test output before the final JSON document.
  const jsonStart = raw.search(/^(?:\{|\[)\r?$/m);
  assert.ok(jsonStart >= 0, 'npm pack did not return a JSON result.');
  const output = JSON.parse(raw.slice(jsonStart));
  const info = Array.isArray(output) ? output[0] : Object.values(output)[0];
  assert.equal(info.version, packageVersion);
  for (const file of info.files) {
    assert.ok(file.path.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'MIGRATION.md'].includes(file.path),
      `Unexpected package file: ${file.path}`);
  }
  for (const name of ['dist/index.js', 'dist/index.d.ts', 'MIGRATION.md']) {
    assert.ok(info.files.some(file => file.path === name), `Missing package file: ${name}`);
  }
  // Extract the archive under this workspace so external dependencies resolve to
  // the installed versions, while all package entry files come from the tarball.
  const extraction = mkdtempSync(path.join(root, '.package-check-'));
  try {
    execFileSync('tar', ['-xzf', path.join(directory, info.filename), '-C', extraction]);
    const modules = path.join(extraction, 'consumer', 'node_modules', '@ireves');
    mkdirSync(modules, { recursive: true });
    const { renameSync } = await import('node:fs');
    renameSync(path.join(extraction, 'package'), path.join(modules, 'common-api'));
    const consumer = path.join(extraction, 'consumer');
    writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}');
    const sample = `import { App, type AppOptions, type ModelBase } from '@ireves/common-api';
const route: ModelBase = { method: 'get', path: '/', controller: (_req, res) => res.sendStatus(200) };
const options: AppOptions = { routers: [{ path: '/', models: [route] }], config: { jwtSecret: 'package-test-key' } };
const app = await App.create(options);
const token = await app.runtime.jwt.createAccessToken({ sub: 'package-user' });
const claims = await app.runtime.jwt.verifyJwt(token);
if (claims.sub !== 'package-user') throw new Error('JWT consumer check failed');
await app.shutdown();
app.runtime.logger.flush();
`;
    writeFileSync(path.join(consumer, 'index.ts'), sample);
    writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      skipLibCheck: true, outDir: './out', rootDir: '.',
    }, include: ['index.ts'] }));
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(consumer, 'tsconfig.json')], { stdio: 'pipe' });
    execFileSync(process.execPath, [path.join(consumer, 'out/index.js')], { stdio: 'pipe' });
    const manifest = JSON.parse(readFileSync(path.join(modules, 'common-api', 'package.json'), 'utf8'));
    assert.equal(manifest.type, 'module');
    console.log(`Verified ${info.filename}: ${info.files.length} allowed files and a typed ESM consumer.`);
  } finally { rmSync(extraction, { recursive: true, force: true }); }
} finally { rmSync(directory, { recursive: true, force: true }); }
