import { describe, expect, it } from 'vitest';
import { MediaDownloadTask } from '../src/engine/media';
import type { DownloadConfig, EngineCallbacks, EngineRuntime } from '../src/engine/types';

type Recorded = { url: string; headers: Record<string, string> };

function harness() {
  const recorded: Recorded[] = [];
  const runtime = {
    http: {
      request: async (url: string, options: { headers: Record<string, string> }) => {
        recorded.push({ url, headers: { ...options.headers } });
        return { status: 500, headers: {}, url, close: () => undefined, stream: (async function* () {})() };
      }
    },
    hostLimiter: { acquire: async () => () => undefined },
    globalLimiter: {},
    logger: () => undefined,
    reservedTargetPaths: new Set<string>()
  } as unknown as EngineRuntime;
  const config = {
    id: 'media-credentials',
    kind: 'media',
    url: 'https://page.example/watch?v=1',
    headers: { Authorization: 'Bearer SECRET-TOKEN' },
    cookies: 'sid=SECRET-COOKIE',
    referrer: ''
  } as unknown as DownloadConfig;
  const task = new MediaDownloadTask(config, runtime, {} as EngineCallbacks) as unknown as {
    prepared: unknown;
    writer: unknown;
    fetchMediaSegment(descriptor: { url: string }): Promise<void>;
  };
  task.writer = {};
  task.prepared = { finalUrl: 'https://cdn.example/master.m3u8' };
  const fetchSegment = (url: string) => task.fetchMediaSegment({ url }).catch(() => undefined);
  return { recorded, fetchSegment };
}

describe('media segment credential scoping', () => {
  it('sends credentials to the page host and the manifest host', async () => {
    const { recorded, fetchSegment } = harness();
    await fetchSegment('https://cdn.example/seg-1.ts');
    await fetchSegment('https://page.example/seg-2.ts');
    for (const call of recorded) {
      expect(call.headers.Authorization).toBe('Bearer SECRET-TOKEN');
      expect(call.headers.Cookie).toBe('sid=SECRET-COOKIE');
    }
  });

  it('does not send credentials to any other host named in the manifest', async () => {
    const { recorded, fetchSegment } = harness();
    await fetchSegment('https://evil.example/seg-3.ts');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.headers.Authorization).toBeUndefined();
    expect(recorded[0]!.headers.Cookie).toBeUndefined();
  });
});
