import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildYtDlpCookieFile,
  cookieDomainFor,
  prepareYtDlpRequest
} from '../src/engine/ytdlp-request';

describe('yt-dlp cookie scoping', () => {
  it('scopes page cookies to the registrable site, never to the whole request chain', () => {
    const file = buildYtDlpCookieFile('https://www.youtube.com/watch?v=fixture', 'SID=secret; HSID=two');
    expect(file).toContain('.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret');
    expect(file).toContain('.youtube.com\tTRUE\t/\tTRUE\t0\tHSID\ttwo');
    expect(file).not.toContain('www.youtube.com');
  });

  it('handles multi-label public suffixes and tenant hosts', () => {
    expect(cookieDomainFor('www.example.co.uk')).toEqual({
      domain: 'example.co.uk',
      includeSubdomains: true
    });
    expect(cookieDomainFor('foo.github.io')).toEqual({
      domain: 'foo.github.io',
      includeSubdomains: true
    });
    expect(cookieDomainFor('bucket.s3.amazonaws.com')).toEqual({
      domain: 'bucket.s3.amazonaws.com',
      includeSubdomains: true
    });
    expect(cookieDomainFor('co.uk')).toBeNull();
  });

  it('keeps loopback and IP cookies host-only', () => {
    expect(cookieDomainFor('127.0.0.1')).toEqual({ domain: '127.0.0.1', includeSubdomains: false });
    expect(cookieDomainFor('localhost')).toEqual({ domain: 'localhost', includeSubdomains: false });
    expect(buildYtDlpCookieFile('http://127.0.0.1:8080/file', 'sid=1')).toContain(
      '127.0.0.1\tFALSE\t/\tFALSE\t0\tsid\t1'
    );
  });

  it('drops malformed or record-breaking cookie pairs', () => {
    const file = buildYtDlpCookieFile(
      'https://example.com/file',
      'good=1; evil=2\nSet-Cookie: injected=1; bad\tname=3; =empty; noequals; $Path=/'
    );
    expect(file).toContain('\tgood\t1');
    expect(file).not.toMatch(/evil|injected|bad\tname|empty|noequals|\$Path/);
  });

  it('does not create a cookie file when there are no cookies', () => {
    expect(buildYtDlpCookieFile('https://example.com/file', '')).toBeNull();
    expect(buildYtDlpCookieFile('blob:nonsense', 'a=b')).toBeNull();
  });
});

describe('yt-dlp request files', () => {
  it('writes the cookie file and keeps the raw cookie out of the process arguments', async () => {
    const request = await prepareYtDlpRequest(
      'https://www.youtube.com/watch?v=fixture',
      { 'User-Agent': 'Fixture UA', Cookie: 'SID=SECRET-VALUE' },
      ''
    );
    try {
      expect(request.args).toContain('--cookies');
      expect(request.args.join('\n')).not.toContain('SECRET-VALUE');
      expect(request.args.join('\n')).not.toContain('Cookie:');
      const index = request.args.indexOf('--cookies');
      const cookiePath = request.args[index + 1]!;
      const contents = await fsp.readFile(cookiePath, 'utf8');
      expect(contents).toContain('.youtube.com\tTRUE');
      expect(contents).toContain('\tSID\tSECRET-VALUE');
    } finally {
      const index = request.args.indexOf('--cookies');
      const cookieDirectory = path.dirname(request.args[index + 1]!);
      await request.cleanup();
      await expect(fsp.access(cookieDirectory)).rejects.toThrow();
    }
  });
});
