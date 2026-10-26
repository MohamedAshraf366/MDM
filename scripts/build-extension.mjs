import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'extension');
const target = path.join(source, 'firefox');
const files = [
  'common.js',
  'background.js',
  'content.js',
  'ui.css',
  'popup.html',
  'popup.js',
  'popup.css',
  'options.html',
  'options.js',
  'options.css'
];

await mkdir(target, { recursive: true });
for (const file of files) {
  await cp(path.join(source, file), path.join(target, file));
}
await cp(path.join(source, 'icons'), path.join(target, 'icons'), { recursive: true });

const sourceManifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const firefoxManifestPath = path.join(target, 'manifest.json');
const firefoxManifest = await readFile(firefoxManifestPath, 'utf8');
const syncedManifest = firefoxManifest.replace(
  /"version":\s*"[^"]*"/,
  `"version": "${sourceManifest.version}"`
);
if (syncedManifest !== firefoxManifest) {
  await writeFile(firefoxManifestPath, syncedManifest);
}
console.log(`Synchronized the Firefox extension ${sourceManifest.version} in ${target}`);
