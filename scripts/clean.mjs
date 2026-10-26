import fsp from 'node:fs/promises';
import path from 'node:path';

const targets = ['dist', 'release'];
for (const target of targets) {
  await fsp.rm(path.resolve(target), { recursive: true, force: true });
}
console.log(`Removed ${targets.join(', ')}.`);
