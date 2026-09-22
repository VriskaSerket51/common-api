import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.resolve(root, 'dist');
if (path.relative(root, target) !== 'dist') throw new Error('Invalid build output path');

// No globbing or arbitrary CLI paths. fs.rm unlinks symlinks instead of following them.
// Retry transient Windows locks; persistent permission errors still fail the build.
await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
