import { describe, expect, it } from 'vitest';
import { buildYouTubeProbe, type YtFormat, type YtInfo } from '../src/engine/youtube';

const URL = 'https://www.youtube.com/watch?v=fixture';

function video(overrides: Partial<YtFormat>): YtFormat {
  return {
    format_id: '137',
    ext: 'mp4',
    vcodec: 'avc1.640028',
    acodec: 'none',
    width: 1920,
    height: 1080,
    fps: 30,
    tbr: 4500,
    filesize: 50_000_000,
    protocol: 'https',
    ...overrides
  };
}

function audio(overrides: Partial<YtFormat>): YtFormat {
  return {
    format_id: '140-1',
    ext: 'm4a',
    vcodec: 'none',
    acodec: 'mp4a.40.2',
    abr: 128,
    tbr: 128,
    filesize: 2_000_000,
    protocol: 'https',
    language: 'ar',
    language_preference: 10,
    ...overrides
  };
}

function info(formats: YtFormat[], overrides: Partial<YtInfo> = {}): YtInfo {
  return {
    id: 'fixture',
    title: 'Fixture video',
    duration: 600,
    is_live: false,
    live_status: 'not_live',
    availability: 'public',
    formats,
    ...overrides
  };
}

describe('youtube probe', () => {
  it('builds one merged format per height and prefers H.264 with the original audio', () => {
    const result = buildYouTubeProbe(URL, info([
      video({}),
      video({ format_id: '248', ext: 'webm', vcodec: 'vp9', tbr: 4200, filesize: 48_000_000 }),
      video({ format_id: '399', ext: 'mp4', vcodec: 'av01.0.08M.08', tbr: 3000, filesize: 40_000_000 }),
      video({ format_id: '136', height: 720, width: 1280, tbr: 2500, filesize: 25_000_000 }),
      video({ format_id: '160', height: 144, width: 256, tbr: 100, filesize: 1_000_000 }),
      audio({ format_id: '140-0', language: 'en', language_preference: -1 }),
      audio({})
    ]));

    expect(result.kind).toBe('youtube');
    expect(result.error).toBe('');
    expect(result.title).toBe('Fixture video');
    expect(result.suggestedFileName).toBe('Fixture video.mp4');
    expect(result.formats.filter((format) => !format.mimeType.startsWith('audio/')).map((format) => format.label)).toEqual([
      '1080p',
      '720p',
      '144p'
    ]);

    const best = result.formats[0]!;
    expect(best.type).toBe('youtube');
    expect(best.id).toBe('youtube:1080:137+140-1');
    expect(best.formatSelector).toBe('137+140-1');
    expect(best.resolution).toBe('1920x1080');
    expect(best.mimeType).toBe('video/mp4');
    expect(best.language).toBe('ar');
    expect(best.sizeBytes).toBe(52_000_000);
    expect(best.protected).toBe(false);

    const audioOnly = result.formats.filter((format) => format.mimeType.startsWith('audio/'));
    expect(audioOnly).toHaveLength(1);
    expect(audioOnly[0]?.id).toBe('youtube:audio:140-1');
    expect(audioOnly[0]?.label).toBe('Audio M4A 128 kbps');
    expect(audioOnly[0]?.formatSelector).toBe('140-1');
    expect(audioOnly[0]?.mimeType).toBe('audio/mp4');
    expect(audioOnly[0]?.sizeBytes).toBe(2_000_000);
  });

  it('uses WebM audio and a WebM container when only VP9 video is available', () => {
    const result = buildYouTubeProbe(URL, info([
      video({ format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', tbr: 4200 }),
      audio({ format_id: '251', ext: 'webm', acodec: 'opus', language: 'en', language_preference: -1, abr: 160 }),
      audio({ format_id: '140-0', ext: 'm4a' })
    ]));

    expect(result.error).toBe('');
    expect(result.formats).toHaveLength(3);
    expect(result.formats[0]?.formatSelector).toBe('248+251');
    expect(result.formats[0]?.mimeType).toBe('video/webm');
    expect(result.formats.filter((format) => format.mimeType.startsWith('audio/')).map((format) => format.formatSelector)).toEqual([
      '140-0',
      '251'
    ]);
    expect(result.suggestedFileName).toBe('Fixture video.webm');
  });

  it('falls back to combined formats when video-only formats have no audio to pair with', () => {
    const result = buildYouTubeProbe(URL, info([
      video({}),
      video({ format_id: '136', height: 720, width: 1280, tbr: 2500, filesize: 25_000_000 }),
      video({ format_id: '18', height: 360, width: 640, tbr: 600, filesize: 8_000_000, acodec: 'mp4a.40.2' })
    ]));

    expect(result.error).toBe('');
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]?.id).toBe('youtube:360:18');
    expect(result.formats[0]?.formatSelector).toBe('18');
    expect(result.formats[0]?.mimeType).toBe('video/mp4');
  });

  it('reports live streams without offering formats', () => {
    const result = buildYouTubeProbe(URL, info([video({})], { is_live: true, live_status: 'is_live' }));
    expect(result.kind).toBe('youtube');
    expect(result.formats).toEqual([]);
    expect(result.error).toMatch(/Live YouTube streams/);
  });

  it('reports DRM-protected videos without offering formats', () => {
    const result = buildYouTubeProbe(URL, info([video({})], { _has_drm: true }));
    expect(result.formats).toEqual([]);
    expect(result.protected).toBe(true);
    expect(result.error).toMatch(/DRM-protected/);
  });

  it('offers audio when storyboard images are the only video tracks', () => {
    const storyboard = video({ format_id: 'sb0', vcodec: 'none', acodec: 'none', height: 90, format_note: 'storyboard' });
    const result = buildYouTubeProbe(URL, info([storyboard, audio({})]));
    expect(result.error).toBe('');
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]?.formatSelector).toBe('140-1');
    expect(result.suggestedFileName).toBe('Fixture video.m4a');
  });

  it('supports audio-only sources and non-MP4 audio extensions', () => {
    const result = buildYouTubeProbe(
      'https://soundcloud.com/fixture/track',
      info([
        audio({ format_id: 'mp3-128', ext: 'mp3', abr: 128 }),
        audio({ format_id: 'm4a-256', ext: 'm4a', abr: 256 })
      ])
    );
    expect(result.error).toBe('');
    expect(result.formats).toHaveLength(2);
    expect(result.formats.map((format) => format.formatSelector)).toEqual(['m4a-256', 'mp3-128']);
    expect(result.formats.map((format) => format.mimeType)).toEqual(['audio/mp4', 'audio/mpeg']);
    expect(result.suggestedFileName).toBe('Fixture video.m4a');

    const mp3 = buildYouTubeProbe(URL, info([audio({ format_id: 'mp3-1', ext: 'mp3' })]));
    expect(mp3.error).toBe('');
    expect(mp3.formats[0]?.mimeType).toBe('audio/mpeg');
    expect(mp3.suggestedFileName).toBe('Fixture video.mp3');
  });

  it('rejects protected members-only videos', () => {
    const members = buildYouTubeProbe(URL, info([video({})], { availability: 'subscriber_only' }));
    expect(members.formats).toEqual([]);
    expect(members.error).toMatch(/channel members/);
  });
});
