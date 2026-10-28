import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fuses from '@electron/fuses';
import constants from '@electron/fuses/dist/constants.js';

const { FuseV1Options, FuseVersion, getCurrentFuseWire } = fuses;
const { FuseState } = constants;

const defaultExecutable = path.join(
  'release',
  'win-unpacked',
  'MDM - Mohamed Download Manager.exe'
);
const executable = path.resolve(process.argv[2] ?? defaultExecutable);
await fsp.access(executable);

const wire = await getCurrentFuseWire(executable);
assert.equal(wire.version, FuseVersion.V1, 'unexpected Electron fuse wire version');

// Keep this list aligned with `electronFuses` in electron-builder.yml.
const expected = [
  ['runAsNode', FuseV1Options.RunAsNode, FuseState.ENABLE],
  ['enableCookieEncryption', FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [
    'enableNodeOptionsEnvironmentVariable',
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseState.DISABLE
  ],
  [
    'enableNodeCliInspectArguments',
    FuseV1Options.EnableNodeCliInspectArguments,
    FuseState.DISABLE
  ],
  [
    'enableEmbeddedAsarIntegrityValidation',
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseState.ENABLE
  ],
  ['onlyLoadAppFromAsar', FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [
    'loadBrowserProcessSpecificV8Snapshot',
    FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    FuseState.DISABLE
  ],
  [
    'grantFileProtocolExtraPrivileges',
    FuseV1Options.GrantFileProtocolExtraPrivileges,
    FuseState.DISABLE
  ]
];

const labels = new Map(Object.entries(FuseState).map(([name, value]) => [value, name]));
const failures = [];
for (const [name, option, wanted] of expected) {
  const actual = wire[option];
  if (actual !== wanted) {
    failures.push(`${name}: expected ${labels.get(wanted) ?? wanted}, found ${labels.get(actual) ?? actual}`);
  }
}

if (failures.length > 0) {
  assert.fail(`Electron fuses are not safe:\n- ${failures.join('\n- ')}`);
}

console.log(`Verified ${expected.length} Electron fuses in ${executable}.`);
