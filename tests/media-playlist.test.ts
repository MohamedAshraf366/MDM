import { describe, expect, it } from 'vitest';
import { parseHlsMediaPlaylist, probeMedia } from '../src/engine/media';
import type { EngineRuntime } from '../src/engine/types';

describe('HLS media playlists', () => {
  it('resolves segments, byte ranges, and fMP4 initialization sections', () => {
    const playlist = parseHlsMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
        '#EXTINF:6.0,',
        'segment-1.m4s',
        '#EXT-X-BYTERANGE:100@720',
        '#EXTINF:6.0,',
        'segment-2.m4s',
        '#EXT-X-ENDLIST'
      ].join('\n'),
      'https://media.example.com/show/master/index.m3u8'
    );

    expect(playlist.extension).toBe('.mp4');
    expect(playlist.totalDuration).toBe(12);
    expect(playlist.endList).toBe(true);
    expect(playlist.encrypted).toBe(false);
    expect(playlist.drm).toBe(false);
    expect(playlist.init).toMatchObject({
      url: 'https://media.example.com/show/master/init.mp4',
      init: true,
      rangeStart: 0,
      rangeEnd: 719
    });
    expect(playlist.segments).toHaveLength(2);
    expect(playlist.segments[0]).toMatchObject({
      url: 'https://media.example.com/show/master/segment-1.m4s',
      duration: 6
    });
    expect(playlist.segments[1]).toMatchObject({
      url: 'https://media.example.com/show/master/segment-2.m4s',
      rangeStart: 720,
      rangeEnd: 819
    });
  });

  it('flags encrypted and DRM-protected playlists', () => {
    const encrypted = parseHlsMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        '#EXTINF:4,',
        'one.ts',
        '#EXT-X-ENDLIST'
      ].join('\n'),
      'https://example.com/stream/index.m3u8'
    );
    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.drm).toBe(false);

    const drm = parseHlsMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"',
        '#EXTINF:4,',
        'one.ts',
        '#EXT-X-ENDLIST'
      ].join('\n'),
      'https://example.com/stream/index.m3u8'
    );
    expect(drm.drm).toBe(true);
  });

  it('tracks relative byte ranges across consecutive segments', () => {
    const playlist = parseHlsMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-BYTERANGE:1000@0',
        '#EXTINF:5,',
        'all.ts',
        '#EXT-X-BYTERANGE:500',
        '#EXTINF:5,',
        'all.ts',
        '#EXT-X-ENDLIST'
      ].join('\n'),
      'https://example.com/stream/index.m3u8'
    );

    expect(playlist.segments[0]).toMatchObject({ rangeStart: 0, rangeEnd: 999 });
    expect(playlist.segments[1]).toMatchObject({ rangeStart: 1000, rangeEnd: 1499 });
  });
});

describe('media URL probing', () => {
  it('reports a clear error for URLs that are not media manifests', async () => {
    const result = await probeMedia('https://example.com/watch/123', {} as EngineRuntime, {}, '');
    expect(result.formats).toHaveLength(0);
    expect(result.error).toMatch(/HLS or DASH/);
  });

  it('recognizes manifest URLs with URL fragments', async () => {
    const runtime = {
      http: {
        request: async () => {
          throw new Error('manifest requested');
        }
      }
    } as unknown as EngineRuntime;
    await expect(probeMedia('https://example.com/master.m3u8#t=10', runtime, {}, '')).rejects.toThrow(
      'manifest requested'
    );
  });
});
