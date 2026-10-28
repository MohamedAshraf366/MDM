import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RENDERER_CSP, createRendererProtocolHandler } from '../src/main/renderer-protocol';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<{ handler: (request: Request) => Promise<Response>; outside: string }> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-renderer-'));
  directories.push(parent);
  const root = path.join(parent, 'renderer');
  await fsp.mkdir(path.join(root, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(root, 'index.html'), '<!doctype html><title>MDM</title>');
  await fsp.writeFile(path.join(root, 'assets', 'app.js'), 'console.log("mdm")');
  await fsp.writeFile(path.join(root, 'assets', 'style.css'), 'body { margin: 0 }');
  const outside = path.join(parent, 'outside.txt');
  await fsp.writeFile(outside, 'not part of the renderer');
  return { handler: createRendererProtocolHandler(root), outside };
}

describe('renderer custom protocol', () => {
  it('serves the renderer with the expected MIME types and CSP', async () => {
    const { handler } = await fixture();
    const index = await handler(new Request('mdm://app/'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('content-security-policy')).toBe(RENDERER_CSP);
    expect(await index.text()).toContain('<title>MDM</title>');

    const script = await handler(new Request('mdm://app/assets/app.js'));
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('content-security-policy')).toBeNull();

    const stylesheet = await handler(new Request('mdm://app/assets/style.css'));
    expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('rejects other hosts and missing files', async () => {
    const { handler } = await fixture();
    expect((await handler(new Request('mdm://evil/index.html'))).status).toBe(404);
    expect((await handler(new Request('mdm://app/missing.html'))).status).toBe(404);
  });

  it('cannot escape the renderer directory', async () => {
    const { handler } = await fixture();
    const escaped = await handler(new Request('mdm://app/%2F..%2Foutside.txt'));
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain('not part of the renderer');

    const malformed = await handler({ url: 'mdm://app/%E0%A4%A' } as Request);
    expect(malformed.status).toBe(400);
  });
});
