import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROMIUM_EXTENSION_ID } from '../src/shared/extension';

/** Chrome maps the first 16 bytes of SHA-256(public key DER) to a-p. */
function extensionIdFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

describe('extension ID pinning', () => {
  it('derives the bridge allowlisted ID from the Chrome manifest key', async () => {
    const manifest = JSON.parse(await fsp.readFile(path.resolve('extension/manifest.json'), 'utf8')) as {
      key?: unknown;
    };
    expect(typeof manifest.key).toBe('string');
    expect(extensionIdFromKey(String(manifest.key))).toBe(CHROMIUM_EXTENSION_ID);
  });

  it('keeps the Firefox manifest free of the Chrome key', async () => {
    const manifest = JSON.parse(
      await fsp.readFile(path.resolve('extension/firefox/manifest.json'), 'utf8')
    ) as { key?: unknown; browser_specific_settings?: { gecko?: { id?: unknown } } };
    expect(manifest.key).toBeUndefined();
    expect(manifest.browser_specific_settings?.gecko?.id).toBe('mdm@mohamed.local');
  });
});
