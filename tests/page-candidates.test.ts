import { describe, expect, it } from 'vitest';
import { extractPageCandidates } from '../src/main/manager';

describe('page candidate extraction', () => {
  it('collects manifests, direct media, and embed pages from page markup', () => {
    const html = `
      <video><source src="/media/stream.m3u8" type="application/x-mpegURL"></video>
      <iframe src="https://embed.example.com/player/abc"></iframe>
      <iframe src="https://embed.example.com/player/abc"></iframe>
      <embed src="https://cdn.example.com/releases/master.txt">
      <meta property="og:video" content="https://cdn.example.com/dash/manifest.mpd">
      <script>
        window.player = { file: "https:\\/\\/cdn.example.com\\/video.mp4", hls: "https:\\/\\/cdn.example.com\\/live/index.m3u8" };
      </script>
    `;

    const candidates = extractPageCandidates(html, 'https://site.example/watch/page.html');

    expect(candidates.manifests).toEqual(
      expect.arrayContaining([
        'https://site.example/media/stream.m3u8',
        'https://cdn.example.com/releases/master.txt',
        'https://cdn.example.com/dash/manifest.mpd',
        'https://cdn.example.com/live/index.m3u8'
      ])
    );
    expect(candidates.pages).toEqual(['https://embed.example.com/player/abc']);
    expect(candidates.manifests.some((url) => url.endsWith('.mp4'))).toBe(false);
  });

  it('ignores malformed, inline, and non-http candidates', () => {
    const html = `
      <iframe src="javascript:alert(1)"></iframe>
      <source src="data:video/mp4;base64,AAAA">
      <iframe src="/relative/player"></iframe>
    `;

    const candidates = extractPageCandidates(html, 'https://site.example/watch/page.html');

    expect(candidates.manifests).toEqual([]);
    expect(candidates.pages).toEqual(['https://site.example/relative/player']);
  });
});
