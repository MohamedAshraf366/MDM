import fsp from 'node:fs/promises';
import path from 'node:path';

export const APP_SCHEME = 'mdm';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_RENDERER_URL = `${APP_ORIGIN}/index.html`;

/** Applied as a header and mirrored by session.webRequest for dev-server URLs. */
export const RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
};

/**
 * Serves the built renderer over `mdm://app` instead of `file://`.
 *
 * The custom scheme is registered as standard and secure in index.ts. Because
 * the renderer no longer needs file-protocol privileges, the packaged app can
 * disable Electron's GrantFileProtocolExtraPrivileges fuse. Requests are
 * confined to the renderer directory, so encoded `..` segments cannot escape
 * into the rest of the application bundle or the user's disk.
 */
export function createRendererProtocolHandler(root: string): (request: Request) => Promise<Response> {
  const rendererRoot = path.resolve(root);
  return async (request) => {
    let target: string;
    try {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      target = path.resolve(rendererRoot, relative);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (target !== rendererRoot && !target.startsWith(rendererRoot + path.sep)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const body = await fsp.readFile(target);
      const extension = path.extname(target).toLowerCase();
      const headers: Record<string, string> = {
        'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      };
      if (extension === '.html') headers['Content-Security-Policy'] = RENDERER_CSP;
      return new Response(body, { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
