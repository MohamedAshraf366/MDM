import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicPlace, buildZoneIdentifier } from '../src/engine/fs-utils';

describe('Mark of the Web', () => {
  it('marks the file as Internet zone 3 with the source and referrer', () => {
    expect(buildZoneIdentifier({ sourceUrl: 'https://files.example/a/b.zip', referrer: 'https://example.com/page' })).toBe(
      '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/page\r\nHostUrl=https://files.example/a/b.zip\r\n'
    );
  });

  it('keeps signed tokens, logins and fragments out of the stream', () => {
    const text = buildZoneIdentifier({ sourceUrl: 'https://user:pw@files.example/b.zip?token=SECRET#frag' });
    expect(text).toContain('HostUrl=https://files.example/b.zip\r\n');
    expect(text).not.toMatch(/SECRET|user|pw|frag/);
  });

  it('omits unusable URLs but still marks the zone', () => {
    expect(buildZoneIdentifier({ sourceUrl: 'blob:nonsense', referrer: 'not a url' })).toBe('[ZoneTransfer]\r\nZoneId=3\r\n');
  });

  it('does not create stray stream files on platforms without alternate data streams', async () => {
    if (process.platform === 'win32') return;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-motw-'));
    await fsp.writeFile(path.join(dir, 'part'), 'data');
    const placed = await atomicPlace(path.join(dir, 'part'), path.join(dir, 'file.bin'), false, {
      sourceUrl: 'https://x.example/f'
    });
    expect(await fsp.readdir(dir)).toEqual([path.basename(placed)]);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
