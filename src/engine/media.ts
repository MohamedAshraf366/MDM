import path from 'node:path';
import fsp from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import type { MediaFormat, MediaProbeResult, ChecksumStatus } from '../shared/types';
import { DownloadError, friendlyErrorMessage, isRetryableNetworkError, mapNetworkError } from './errors';
import {
  CookieJar as CookieJarClass,
  contentLength,
  httpStatusError,
  sharesCredentialScope,
  stripSensitiveHeaders,
  type CookieJar,
  type HttpResponse
} from './http-client';
import {
  atomicPlace,
  checkDiskSpace,
  fileExists,
  resolveTargetPath,
  reservedPathsExcept,
  SparseFileWriter,
  tempFilePath
} from './fs-utils';
import { hashFile } from './checksum';
import { backoffDelay, SpeedMeter } from './rate-limiter';
import { CHECKPOINT_INTERVAL_MS, PROGRESS_INTERVAL_MS } from '../shared/defaults';
import { deriveFileNameFromUrl, sanitizeFileName } from '../shared/validation';
import type {
  DownloadConfig,
  EngineCallbacks,
  EngineCheckpoint,
  EngineOutcome,
  EngineRuntime,
  PreparedDownload,
  ResumeState
} from './types';
import type { DownloadSegment } from '../shared/types';

interface MediaSegmentDescriptor {
  url: string;
  rangeStart?: number;
  rangeEnd?: number;
  duration?: number;
  init?: boolean;
}

interface MediaPlan {
  v: 1;
  kind: 'hls' | 'dash';
  title: string;
  extension: string;
  init: MediaSegmentDescriptor | null;
  segments: MediaSegmentDescriptor[];
  totalDuration: number | null;
  manifestUrl: string;
  formatId: string;
}

interface MediaState {
  plan: MediaPlan;
  nextIndex: number;
  outputBytes: number;
  totalBytes: number | null;
  initDone: boolean;
}

interface HlsParseResult {
  formats: MediaFormat[];
  master: boolean;
  title: string;
}

interface HlsMediaPlaylist {
  segments: MediaSegmentDescriptor[];
  init: MediaSegmentDescriptor | null;
  totalDuration: number;
  endList: boolean;
  encrypted: boolean;
  drm: boolean;
  extension: string;
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

function resolveUrl(reference: string, base: string): string {
  try {
    return new URL(reference, base).toString();
  } catch {
    throw new DownloadError('The media manifest contains an invalid URL.', 'UNSUPPORTED_MEDIA');
  }
}

function parseAttributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line))) {
    const key = match[1]?.toUpperCase();
    if (!key) continue;
    let value = match[2] ?? '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function hlsFormatsFromMaster(text: string, baseUrl: string): HlsParseResult {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const formats: MediaFormat[] = [];
  const seen = new Set<string>();
  let audioProtected = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-SESSION-KEY:'.length));
      if ((attrs.METHOD ?? 'NONE') !== 'NONE') audioProtected = true;
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    let nextIndex = i + 1;
    while (nextIndex < lines.length) {
      const candidate = lines[nextIndex] ?? '';
      if (candidate && !candidate.startsWith('#')) break;
      nextIndex++;
    }
    const uri = lines[nextIndex];
    if (!uri || uri.startsWith('#')) continue;
    const mediaUrl = resolveUrl(uri, baseUrl);
    if (seen.has(mediaUrl)) continue;
    seen.add(mediaUrl);
    const resolution = attrs.RESOLUTION ?? '';
    const bandwidth = Number(attrs.BANDWIDTH ?? attrs['AVERAGE-BANDWIDTH'] ?? 0);
    const codecs = attrs.CODECS ?? '';
    const frameRate = attrs['FRAME-RATE'];
    const label = resolution || (bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : 'HLS stream');
    formats.push({
      id: `hls-${formats.length}`,
      label: resolution ? `${resolution}${frameRate ? ` @${Number(frameRate).toFixed(0)}fps` : ''}` : label,
      url: mediaUrl,
      bandwidth,
      resolution,
      codecs,
      mimeType: 'application/vnd.apple.mpegurl',
      language: '',
      protected: audioProtected,
      type: 'hls'
    });
    i = nextIndex;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
    if ((attrs.TYPE ?? '').toUpperCase() !== 'AUDIO' || !attrs.URI) continue;
    const mediaUrl = resolveUrl(attrs.URI, baseUrl);
    if (seen.has(mediaUrl)) continue;
    seen.add(mediaUrl);
    const label = `${attrs.NAME ?? attrs.LANGUAGE ?? 'Audio'}${attrs.LANGUAGE ? ` (${attrs.LANGUAGE})` : ''}`;
    formats.push({
      id: `hls-${formats.length}`,
      label,
      url: mediaUrl,
      bandwidth: 0,
      resolution: '',
      codecs: attrs.CODECS ?? '',
      mimeType: 'application/vnd.apple.mpegurl',
      language: attrs.LANGUAGE ?? '',
      protected: audioProtected,
      type: 'hls'
    });
  }
  return { formats, master: true, title: '' };
}

function parseByteRange(value: string, previousEnd: number): { start: number; end: number } {
  const [lengthText, offsetText] = value.split('@');
  const length = Number(lengthText);
  const start = offsetText !== undefined ? Number(offsetText) : previousEnd + 1;
  if (!Number.isFinite(length) || !Number.isFinite(start) || length <= 0) {
    throw new DownloadError('The HLS manifest contains an invalid byte range.', 'UNSUPPORTED_MEDIA');
  }
  return { start, end: start + length - 1 };
}

export function parseHlsMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const segments: MediaSegmentDescriptor[] = [];
  let duration = 0;
  let pendingDuration = 0;
  let pendingRange: string | null = null;
  let previousRangeEnd = -1;
  let init: MediaSegmentDescriptor | null = null;
  let endList = false;
  let encrypted = false;
  let drm = false;
  let extension = '.ts';
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD ?? 'NONE').toUpperCase();
      if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') drm = true;
      else if (method !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      drm = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        if (/\.m4s|\.mp4/i.test(attrs.URI)) extension = '.mp4';
        init = { url: resolveUrl(attrs.URI, baseUrl), init: true };
        if (attrs.BYTERANGE) {
          const range = parseByteRange(attrs.BYTERANGE, -1);
          init.rangeStart = range.start;
          init.rangeEnd = range.end;
        }
      }
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      if (!Number.isFinite(pendingDuration) || pendingDuration < 0) pendingDuration = 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      const segment: MediaSegmentDescriptor = { url, duration: pendingDuration };
      if (pendingRange) {
        const range = parseByteRange(pendingRange, previousRangeEnd);
        segment.rangeStart = range.start;
        segment.rangeEnd = range.end;
        previousRangeEnd = range.end;
      } else {
        previousRangeEnd = -1;
      }
      if (/\.m4s|\.mp4/i.test(line)) extension = '.mp4';
      segments.push(segment);
      duration += pendingDuration;
      pendingDuration = 0;
      pendingRange = null;
    }
  }
  return { segments, init, totalDuration: duration, endList, encrypted, drm, extension };
}

function hlsMediaFormat(url: string, title: string): MediaFormat {
  return {
    id: 'hls-direct',
    label: title || 'HLS stream',
    url,
    bandwidth: 0,
    resolution: '',
    codecs: '',
    mimeType: 'application/vnd.apple.mpegurl',
    language: '',
    protected: false,
    type: 'hls'
  };
}

export async function probeHls(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string
): Promise<MediaProbeResult> {
  const cookieJar = new CookieJarClass();
  const response = await runtime.http.request(url, { headers: { ...headers, Cookie: cookies }, cookieJar });
  const buffer = await readBodyLimited(response, MAX_MANIFEST_BYTES);
  if (response.status < 200 || response.status >= 300) throw httpStatusError(response.status, response.headers, response.url);
  const text = buffer.toString('utf8');
  if (!text.includes('#EXTM3U')) {
    throw new DownloadError('The URL did not return an HLS playlist.', 'UNSUPPORTED_MEDIA');
  }
  const baseUrl = response.url;
  const title = deriveFileNameFromUrl(baseUrl, 'stream').replace(/\.[^.]+$/, '');
  if (text.includes('#EXT-X-STREAM-INF:')) {
    const master = hlsFormatsFromMaster(text, baseUrl);
    let mediaError = '';
    if (master.formats.length === 0) mediaError = 'No downloadable HLS variants were found.';
    return {
      kind: 'hls',
      title: title || 'HLS stream',
      formats: master.formats,
      durationSeconds: null,
      protected: master.formats.some((format) => format.protected),
      error: mediaError,
      suggestedFileName: `${sanitizeFileName(title || 'hls-stream')}.mp4`
    };
  }
  const playlist = parseHlsMediaPlaylist(text, baseUrl);
  if (playlist.drm) {
    return {
      kind: 'hls',
      title,
      formats: [],
      durationSeconds: playlist.totalDuration || null,
      protected: true,
      error: 'This HLS stream is DRM-protected. MDM does not bypass DRM.',
      suggestedFileName: `${sanitizeFileName(title || 'hls-stream')}${playlist.extension}`
    };
  }
  if (playlist.encrypted) {
    return {
      kind: 'hls',
      title,
      formats: [],
      durationSeconds: playlist.totalDuration || null,
      protected: true,
      error: 'This HLS stream is encrypted. MDM only downloads unencrypted media you are authorized to save.',
      suggestedFileName: `${sanitizeFileName(title || 'hls-stream')}${playlist.extension}`
    };
  }
  if (!playlist.endList) {
    return {
      kind: 'hls',
      title,
      formats: [],
      durationSeconds: null,
      protected: false,
      error: 'Live HLS streams are not supported. Only completed VOD playlists can be downloaded.',
      suggestedFileName: `${sanitizeFileName(title || 'hls-stream')}${playlist.extension}`
    };
  }
  return {
    kind: 'hls',
    title: title || 'HLS stream',
    formats: [hlsMediaFormat(baseUrl, title || 'HLS stream')],
    durationSeconds: playlist.totalDuration || null,
    protected: false,
    error: '',
    suggestedFileName: `${sanitizeFileName(title || 'hls-stream')}${playlist.extension}`
  };
}

function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (!match) return null;
  const [, years, months, days, hours, minutes, seconds] = match;
  return (
    (Number(years ?? 0) * 365 * 24 * 3600) +
    (Number(months ?? 0) * 30 * 24 * 3600) +
    (Number(days ?? 0) * 24 * 3600) +
    (Number(hours ?? 0) * 3600) +
    (Number(minutes ?? 0) * 60) +
    Number(seconds ?? 0)
  );
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function joinBase(base: string, child: string | undefined): string {
  if (!child) return base;
  return resolveUrl(child, base);
}

function substituteTemplate(template: string, context: Record<string, string | number>): string {
  return template.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (_match, name: string, width: string | undefined) => {
    const value = context[name];
    if (value === undefined) return `$${name}$`;
    const text = String(value);
    return width ? text.padStart(Number(width), '0') : text;
  });
}

export async function probeDash(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string
): Promise<MediaProbeResult> {
  const cookieJar = new CookieJarClass();
  const response = await runtime.http.request(url, { headers: { ...headers, Cookie: cookies }, cookieJar });
  const buffer = await readBodyLimited(response, MAX_MANIFEST_BYTES);
  if (response.status < 200 || response.status >= 300) throw httpStatusError(response.status, response.headers, response.url);
  const manifest = buffer.toString('utf8');
  const baseUrl = response.url;
  const title = deriveFileNameFromUrl(baseUrl, 'stream').replace(/\.[^.]+$/, '');
  if (!/<MPD[\s>]/i.test(manifest)) throw new DownloadError('The URL did not return a DASH manifest.', 'UNSUPPORTED_MEDIA');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  const doc = parser.parse(manifest) as Record<string, any>;
  const mpd = doc.MPD;
  if (!mpd) throw new DownloadError('The DASH manifest could not be parsed.', 'UNSUPPORTED_MEDIA');
  if (String(mpd['@_type'] ?? 'static').toLowerCase() === 'dynamic') {
    return {
      kind: 'dash',
      title,
      formats: [],
      durationSeconds: null,
      protected: false,
      error: 'Live DASH streams are not supported.',
      suggestedFileName: `${sanitizeFileName(title || 'dash-stream')}.mp4`
    };
  }
  const protectedManifest = manifest.includes('ContentProtection') || manifest.includes('cbcs') || manifest.includes('cenc');
  const duration = parseIsoDuration(mpd['@_mediaPresentationDuration']);
  const formats: MediaFormat[] = [];
  const periods = asArray(mpd.Period);
  const mpdBase = joinBase(baseUrl, typeof mpd.BaseURL === 'string' ? mpd.BaseURL : mpd.BaseURL?.['#text']);
  periods.forEach((period: any, periodIndex: number) => {
    const periodBase = joinBase(mpdBase, typeof period.BaseURL === 'string' ? period.BaseURL : period.BaseURL?.['#text']);
    const adaptationSets = asArray(period.AdaptationSet);
    adaptationSets.forEach((set: any, setIndex: number) => {
      const setBase = joinBase(periodBase, typeof set.BaseURL === 'string' ? set.BaseURL : set.BaseURL?.['#text']);
      const contentType = String(set['@_contentType'] ?? set['@_mimeType'] ?? '').toLowerCase();
      const representations = asArray(set.Representation);
      representations.forEach((rep: any, repIndex: number) => {
        const repBase = joinBase(setBase, typeof rep.BaseURL === 'string' ? rep.BaseURL : rep.BaseURL?.['#text']);
        const mimeType = String(rep['@_mimeType'] ?? set['@_mimeType'] ?? 'video/mp4');
        const isAudio = contentType.startsWith('audio') || mimeType.startsWith('audio');
        const width = Number(rep['@_width'] ?? set['@_width'] ?? 0);
        const height = Number(rep['@_height'] ?? set['@_height'] ?? 0);
        const bandwidth = Number(rep['@_bandwidth'] ?? 0);
        const label = isAudio
          ? `${String(rep['@_audioSamplingRate'] ?? 'Audio')}${rep['@_lang'] ? ` ${String(rep['@_lang'])}` : ''}`
          : height
            ? `${width}x${height}`
            : `${Math.round(bandwidth / 1000)} kbps`;
        const format: MediaFormat = {
          id: `dash:${periodIndex}:${setIndex}:${repIndex}`,
          label: isAudio ? `Audio · ${label}` : label,
          url: baseUrl,
          bandwidth,
          resolution: width && height ? `${width}x${height}` : '',
          codecs: String(rep['@_codecs'] ?? set['@_codecs'] ?? ''),
          mimeType,
          language: String(rep['@_lang'] ?? set['@_lang'] ?? ''),
          protected: protectedManifest,
          type: 'dash'
        };
        formats.push(format);
        void repBase;
      });
    });
  });
  return {
    kind: 'dash',
    title: title || 'DASH stream',
    formats,
    durationSeconds: duration,
    protected: protectedManifest,
    error: protectedManifest
      ? 'This DASH manifest includes DRM protection. MDM does not bypass DRM.'
      : formats.length === 0
        ? 'No downloadable DASH representations were found.'
        : '',
    suggestedFileName: `${sanitizeFileName(title || 'dash-stream')}.mp4`
  };
}

async function readBodyLimited(response: HttpResponse, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of response.stream) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += buffer.length;
    if (total > maxBytes) throw new DownloadError('The media manifest is too large.', 'UNSUPPORTED_MEDIA');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const SNIFF_BYTES = 64 * 1024;

/**
 * Reads the start of a response body without trusting the URL extension. Many
 * HLS hosts publish the master playlist as master.txt or with no extension.
 */
async function sniffManifestType(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string,
  cookieJar: CookieJar
): Promise<'hls' | 'dash' | null> {
  let response: HttpResponse | null = null;
  try {
    const requestHeaders: Record<string, string> = {
      ...headers,
      ...(cookies ? { Cookie: cookies } : {}),
      Range: `bytes=0-${SNIFF_BYTES - 1}`
    };
    response = await runtime.http.request(url, { headers: requestHeaders, cookieJar });
    if ([400, 403, 405, 501].includes(response.status)) {
      response.close();
      response = null;
      delete requestHeaders.Range;
      response = await runtime.http.request(url, { headers: requestHeaders, cookieJar });
    }
    if (!response || response.status >= 400) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of response.stream) {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= SNIFF_BYTES) break;
    }
    const text = Buffer.concat(chunks).subarray(0, SNIFF_BYTES).toString('utf8');
    if (text.includes('#EXTM3U')) return 'hls';
    if (/<MPD[\s>]/i.test(text)) return 'dash';
    return null;
  } catch {
    return null;
  } finally {
    response?.close();
  }
}

async function buildDashPlan(
  manifestUrl: string,
  formatId: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string,
  cookieJar: CookieJar
): Promise<MediaPlan> {
  const response = await runtime.http.request(manifestUrl, { headers: { ...headers, Cookie: cookies }, cookieJar });
  const buffer = await readBodyLimited(response, MAX_MANIFEST_BYTES);
  if (response.status < 200 || response.status >= 300) throw httpStatusError(response.status, response.headers, response.url);
  const manifest = buffer.toString('utf8');
  if (/ContentProtection|cbcs|cenc/i.test(manifest)) {
    throw new DownloadError('This DASH manifest is DRM-protected.', 'DRM_PROTECTED');
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  const doc = parser.parse(manifest) as Record<string, any>;
  const mpd = doc.MPD;
  if (!mpd) throw new DownloadError('The DASH manifest could not be parsed.', 'UNSUPPORTED_MEDIA');
  if (String(mpd['@_type'] ?? 'static').toLowerCase() === 'dynamic') {
    throw new DownloadError('Live DASH streams are not supported.', 'UNSUPPORTED_MEDIA');
  }
  const target = /^dash:(\d+):(\d+):(\d+)$/.exec(formatId);
  if (!target) throw new DownloadError('The selected DASH format is not valid.', 'UNSUPPORTED_MEDIA');
  const [, periodIndexText, setIndexText, repIndexText] = target;
  const periods = asArray(mpd.Period);
  const period = periods[Number(periodIndexText)];
  if (!period) throw new DownloadError('The selected DASH period is missing.', 'UNSUPPORTED_MEDIA');
  const sets = asArray(period.AdaptationSet);
  const set = sets[Number(setIndexText)];
  if (!set) throw new DownloadError('The selected DASH adaptation set is missing.', 'UNSUPPORTED_MEDIA');
  const reps = asArray(set.Representation);
  const rep = reps[Number(repIndexText)];
  if (!rep) throw new DownloadError('The selected DASH representation is missing.', 'UNSUPPORTED_MEDIA');

  const mpdBase = joinBase(response.url, typeof mpd.BaseURL === 'string' ? mpd.BaseURL : mpd.BaseURL?.['#text']);
  const periodBase = joinBase(mpdBase, typeof period.BaseURL === 'string' ? period.BaseURL : period.BaseURL?.['#text']);
  const setBase = joinBase(periodBase, typeof set.BaseURL === 'string' ? set.BaseURL : set.BaseURL?.['#text']);
  const repBase = joinBase(setBase, typeof rep.BaseURL === 'string' ? rep.BaseURL : rep.BaseURL?.['#text']);
  const template = rep.SegmentTemplate ?? set.SegmentTemplate;
  const segmentList = rep.SegmentList ?? set.SegmentList;
  const mimeType = String(rep['@_mimeType'] ?? set['@_mimeType'] ?? 'video/mp4');
  const extension = mimeType.startsWith('audio/')
    ? mimeType.includes('webm')
      ? '.weba'
      : '.m4a'
    : mimeType.includes('webm')
      ? '.webm'
      : '.mp4';
  const title = deriveFileNameFromUrl(manifestUrl, 'dash-stream').replace(/\.[^.]+$/, '');
  const periodDuration = parseIsoDuration(period['@_duration']) ?? parseIsoDuration(mpd['@_mediaPresentationDuration']);
  const context = {
    RepresentationID: String(rep['@_id'] ?? ''),
    Bandwidth: Number(rep['@_bandwidth'] ?? 0),
    Number: 1,
    Time: 0
  };
  const segments: MediaSegmentDescriptor[] = [];
  let init: MediaSegmentDescriptor | null = null;

  if (template) {
    const timescale = Number(template['@_timescale'] ?? 1);
    const durationUnits = Number(template['@_duration'] ?? 0);
    const startNumber = Number(template['@_startNumber'] ?? 1);
    const mediaTemplate = String(template['@_media'] ?? '');
    const initTemplate = String(template['@_initialization'] ?? '');
    if (initTemplate) init = { url: resolveUrl(substituteTemplate(initTemplate, context), repBase), init: true };
    if (!mediaTemplate) throw new DownloadError('The DASH SegmentTemplate has no media template.', 'UNSUPPORTED_MEDIA');
    const timeline = asArray(template.SegmentTimeline?.S);
    if (timeline.length) {
      let time = Number(timeline[0]?.['@_t'] ?? 0);
      let number = startNumber;
      for (const element of timeline) {
        const repeat = Number(element['@_r'] ?? 0);
        const segmentDuration = Number(element['@_d'] ?? 0);
        time = Number(element['@_t'] ?? time);
        if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) continue;
        for (let repeatIndex = 0; repeatIndex <= repeat; repeatIndex++) {
          context.Time = time;
          context.Number = number;
          segments.push({ url: resolveUrl(substituteTemplate(mediaTemplate, context), repBase), duration: segmentDuration / timescale });
          time += segmentDuration;
          number++;
        }
      }
    } else if (durationUnits > 0 && periodDuration !== null) {
      const count = Math.ceil((periodDuration * timescale) / durationUnits);
      for (let index = 0; index < count; index++) {
        context.Number = startNumber + index;
        context.Time = index * durationUnits;
        segments.push({ url: resolveUrl(substituteTemplate(mediaTemplate, context), repBase), duration: durationUnits / timescale });
      }
    } else if (Number(template['@_endNumber'] ?? 0) > 0) {
      const endNumber = Number(template['@_endNumber']);
      for (let number = startNumber; number <= endNumber; number++) {
        context.Number = number;
        segments.push({ url: resolveUrl(substituteTemplate(mediaTemplate, context), repBase) });
      }
    } else {
      throw new DownloadError('The DASH SegmentTemplate is missing timing information.', 'UNSUPPORTED_MEDIA');
    }
  } else if (segmentList) {
    const initEl = segmentList.Initialization;
    if (initEl?.['@_sourceURL']) init = { url: resolveUrl(String(initEl['@_sourceURL']), repBase), init: true };
    const urls = asArray(segmentList.SegmentURL);
    if (!urls.length) throw new DownloadError('The DASH SegmentList is empty.', 'UNSUPPORTED_MEDIA');
    for (const urlElement of urls) {
      const media = urlElement['@_media'];
      if (!media) continue;
      const descriptor: MediaSegmentDescriptor = { url: resolveUrl(String(media), repBase) };
      if (urlElement['@_mediaRange']) {
        const range = parseDashRange(String(urlElement['@_mediaRange']));
        descriptor.rangeStart = range.start;
        descriptor.rangeEnd = range.end;
      }
      segments.push(descriptor);
    }
  } else if (repBase) {
    segments.push({ url: repBase });
  }
  if (!segments.length) throw new DownloadError('No DASH segments could be derived from the manifest.', 'UNSUPPORTED_MEDIA');
  return {
    v: 1,
    kind: 'dash',
    title,
    extension,
    init,
    segments,
    totalDuration: periodDuration,
    manifestUrl,
    formatId
  };
}

function parseDashRange(value: string): { start: number; end: number } {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) throw new DownloadError('The DASH manifest contains an invalid byte range.', 'UNSUPPORTED_MEDIA');
  return { start: Number(match[1]), end: Number(match[2]) };
}

async function buildHlsPlan(
  playlistUrl: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string,
  cookieJar: CookieJar
): Promise<MediaPlan> {
  const response = await runtime.http.request(playlistUrl, { headers: { ...headers, Cookie: cookies }, cookieJar });
  const buffer = await readBodyLimited(response, MAX_MANIFEST_BYTES);
  if (response.status < 200 || response.status >= 300) throw httpStatusError(response.status, response.headers, response.url);
  const text = buffer.toString('utf8');
  if (!text.includes('#EXTM3U')) throw new DownloadError('The HLS playlist is invalid.', 'UNSUPPORTED_MEDIA');
  if (text.includes('#EXT-X-STREAM-INF:')) {
    throw new DownloadError('Select a specific HLS variant before downloading.', 'UNSUPPORTED_MEDIA');
  }
  const playlist = parseHlsMediaPlaylist(text, response.url);
  if (playlist.drm) throw new DownloadError('This HLS stream is DRM-protected.', 'DRM_PROTECTED');
  if (playlist.encrypted) throw new DownloadError('This HLS stream is encrypted.', 'ENCRYPTED_MEDIA');
  if (!playlist.endList) throw new DownloadError('Live HLS streams are not supported.', 'UNSUPPORTED_MEDIA');
  if (!playlist.segments.length) throw new DownloadError('The HLS playlist has no segments.', 'UNSUPPORTED_MEDIA');
  const title = deriveFileNameFromUrl(response.url, 'hls-stream').replace(/\.[^.]+$/, '');
  return {
    v: 1,
    kind: 'hls',
    title,
    extension: playlist.extension,
    init: playlist.init,
    segments: playlist.segments,
    totalDuration: playlist.totalDuration,
    manifestUrl: response.url,
    formatId: 'hls-direct'
  };
}

export async function probeMedia(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string
): Promise<MediaProbeResult> {
  const normalized = url.toLowerCase().split(/[?#]/)[0] ?? '';
  if (normalized.endsWith('.m3u8') || normalized.endsWith('.m3u')) {
    return probeHls(url, runtime, headers, cookies);
  }
  if (normalized.endsWith('.mpd')) {
    return probeDash(url, runtime, headers, cookies);
  }
  // Unknown or misleading extension: sniff the body before deciding. Hosts
  // such as .urlset/master.txt serve HLS playlists without an .m3u8 name.
  const sniffed = await sniffManifestType(url, runtime, headers, cookies, new CookieJarClass());
  if (sniffed === 'hls') {
    return probeHls(url, runtime, headers, cookies);
  }
  if (sniffed === 'dash') {
    return probeDash(url, runtime, headers, cookies);
  }
  return {
    kind: 'http',
    title: deriveFileNameFromUrl(url, 'download'),
    formats: [],
    durationSeconds: null,
    protected: false,
    error: 'This URL is not an HLS or DASH media manifest.',
    suggestedFileName: deriveFileNameFromUrl(url, 'download')
  };
}

export class MediaDownloadTask {
  private readonly config: DownloadConfig;
  private readonly runtime: EngineRuntime;
  private readonly callbacks: EngineCallbacks;
  private readonly controller = new AbortController();
  private readonly speedMeter = new SpeedMeter();
  private readonly cookieJar: CookieJar;
  private paused = false;
  private canceled = false;
  private attempts = 0;
  private prepared: PreparedDownload | null = null;
  private writer: SparseFileWriter | null = null;
  private state: MediaState | null = null;
  private lastProgressAt = 0;
  private lastCheckpointAt = 0;
  private checkpointChain: Promise<void> = Promise.resolve();
  private currentOutputBytes = 0;

  constructor(config: DownloadConfig, runtime: EngineRuntime, callbacks: EngineCallbacks) {
    this.config = config;
    this.runtime = runtime;
    this.callbacks = callbacks;
    this.cookieJar = new CookieJarClass();
  }

  pause(): void {
    if (this.canceled || this.paused) return;
    this.paused = true;
    this.controller.abort();
  }

  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    this.controller.abort();
  }

  async run(): Promise<EngineOutcome> {
    try {
      await this.prepare();
      await this.download();
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) return { status: 'canceled' };
      return await this.finalize();
    } catch (error) {
      if (this.canceled) {
        await this.cleanupTemp();
        return { status: 'canceled' };
      }
      if (this.paused) return this.pausedOutcome();
      throw mapNetworkError(error);
    } finally {
      await this.closeWriter();
    }
  }

  private async prepare(): Promise<void> {
    const resume = this.config.resume;
    let plan: MediaPlan | null = null;
    let outputBytes = 0;
    let nextIndex = 0;
    let initDone = false;
    const resumeState = this.parseResumeState(resume);
    if (resumeState) {
      plan = resumeState.plan;
      outputBytes = resumeState.outputBytes;
      nextIndex = resumeState.nextIndex;
      initDone = Boolean(resumeState.initDone);
    } else {
      const format = this.config.mediaFormat;
      if (!format) throw new DownloadError('No media format was selected.', 'UNSUPPORTED_MEDIA');
      if (this.config.kind === 'hls') {
        plan = await buildHlsPlan(format.url, this.runtime, this.config.headers, this.config.cookies, this.cookieJar);
      } else if (this.config.kind === 'dash') {
        plan = await buildDashPlan(format.url, format.id, this.runtime, this.config.headers, this.config.cookies, this.cookieJar);
      } else {
        throw new DownloadError('Unsupported media type.', 'UNSUPPORTED_MEDIA');
      }
    }

    const extension = plan.extension;
    const baseTitle = sanitizeFileName(
      this.config.fileNameExplicit && this.config.fileName
        ? this.config.fileName
        : this.config.fileName || plan.title || 'media-download'
    );
    const hasExtension = /\.[a-z0-9]{2,10}$/i.test(baseTitle);
    const fileName = hasExtension ? sanitizeFileName(baseTitle) : sanitizeFileName(`${baseTitle}${extension}`);
    let destinationDir = path.resolve(this.config.destinationDir);
    if (this.runtime.resolveDirectory) {
      destinationDir = await this.runtime.resolveDirectory(fileName, this.mimeForExtension(extension));
    }
    await fsp.mkdir(destinationDir, { recursive: true });

    let tempPath: string;
    let targetPath: string;
    if (resumeState && resume?.tempPath && resume.tempPath && path.dirname(path.resolve(resume.tempPath)) === path.resolve(destinationDir) && (await fileExists(resume.tempPath))) {
      tempPath = resume.tempPath;
      targetPath = path.dirname(path.resolve(resume.targetPath)) === path.resolve(destinationDir)
        ? await resolveTargetPath(destinationDir, path.basename(resume.targetPath), 'rename', this.reservedSet())
        : await resolveTargetPath(destinationDir, fileName, this.config.conflictPolicy, this.reservedSet());
    } else {
      if (resume?.tempPath) await fsp.rm(resume.tempPath, { force: true }).catch(() => undefined);
      outputBytes = 0;
      nextIndex = 0;
      initDone = false;
      tempPath = tempFilePath(destinationDir, this.config.id);
      targetPath = await resolveTargetPath(destinationDir, fileName, this.config.conflictPolicy, this.reservedSet());
    }
    await checkDiskSpace(destinationDir, null, this.runtime.diskSpaceProbe);
    this.state = { plan, nextIndex, outputBytes, totalBytes: null, initDone };
    this.currentOutputBytes = outputBytes;
    const segments: DownloadSegment[] = [
      { index: 0, startByte: 0, endByte: null, downloadedBytes: outputBytes, status: 'active' }
    ];
    this.prepared = {
      finalUrl: plan.manifestUrl,
      fileName,
      destinationDir,
      targetPath,
      tempPath,
      totalBytes: null,
      downloadedBytes: outputBytes,
      resumable: plan.kind === 'dash' || plan.segments.length > 0,
      etag: '',
      lastModified: '',
      mimeType: this.mimeForExtension(extension),
      segments,
      kind: plan.kind,
      mediaState: JSON.stringify(this.state)
    };
    this.writer = new SparseFileWriter(tempPath);
    await this.writer.open(null);
    if (!resumeState) await this.writer.truncate(0);
    else await this.writer.truncate(outputBytes);
    await this.callbacks.onPrepared(this.prepared, plan.segments.map((segment) => segment.url));
    await this.saveCheckpoint(true);
    this.emitProgress('downloading');
  }

  private async download(): Promise<void> {
    if (!this.state || !this.writer || !this.prepared) throw new DownloadError('Media download not prepared.', 'INTERNAL');
    if (this.state.plan.init && !this.state.initDone) {
      const initStart = this.currentOutputBytes;
      await this.fetchWithRetry(this.state.plan.init, initStart);
      this.state.initDone = true;
      this.state.outputBytes = this.currentOutputBytes;
      this.prepared.downloadedBytes = this.currentOutputBytes;
      this.refreshSyntheticSegment();
      await this.saveCheckpoint(true);
    }
    for (let index = this.state.nextIndex; index < this.state.plan.segments.length; index++) {
      if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
      const descriptor = this.state.plan.segments[index]!;
      const segmentStart = this.currentOutputBytes;
      await this.fetchWithRetry(descriptor, segmentStart);
      this.state.nextIndex = index + 1;
      this.state.outputBytes = this.currentOutputBytes;
      this.prepared.downloadedBytes = this.currentOutputBytes;
      this.refreshSyntheticSegment();
      void this.saveCheckpoint(false);
      this.emitProgress('downloading');
    }
  }

  private async fetchWithRetry(descriptor: MediaSegmentDescriptor, segmentStart: number): Promise<void> {
    for (;;) {
      try {
        await this.fetchMediaSegment(descriptor);
        return;
      } catch (error) {
        if (this.paused || this.canceled) {
          await this.rollbackTo(segmentStart);
          throw error;
        }
        const mapped = mapNetworkError(error);
        if (!isRetryableNetworkError(mapped) || this.attempts >= this.config.maxRetries) throw mapped;
        this.attempts++;
        await this.rollbackTo(segmentStart);
        const delay = backoffDelay(this.attempts, this.config.retryBaseDelayMs, mapped.retryAfterMs);
        this.log('warn', `${friendlyErrorMessage(mapped)} Retrying media segment in ${Math.round(delay / 1000)}s.`);
        this.emitProgress('downloading');
        await this.sleep(delay);
      }
    }
  }

  private async fetchMediaSegment(descriptor: MediaSegmentDescriptor): Promise<void> {
    if (!this.writer || !this.prepared) throw new DownloadError('Media download not prepared.', 'INTERNAL');
    // A manifest can list segments on any host. Only the hosts the user actually
    // opened (the page and the manifest) receive the captured credentials.
    const trusted =
      sharesCredentialScope(this.config.url, descriptor.url) ||
      sharesCredentialScope(this.prepared.finalUrl, descriptor.url);
    const headers: Record<string, string> = trusted
      ? { ...this.config.headers }
      : stripSensitiveHeaders(this.config.headers);
    if (this.config.cookies && trusted) headers.Cookie = this.config.cookies;
    if (this.config.referrer) headers.Referer = this.config.referrer;
    if (descriptor.rangeStart !== undefined && descriptor.rangeEnd !== undefined) {
      headers.Range = `bytes=${descriptor.rangeStart}-${descriptor.rangeEnd}`;
    }
    const hostname = new URL(descriptor.url).hostname;
    const release = await this.runtime.hostLimiter.acquire(hostname, this.controller.signal);
    let response: HttpResponse | undefined;
    try {
      response = await this.runtime.http.request(descriptor.url, {
        headers,
        signal: this.controller.signal,
        cookieJar: this.cookieJar
      });
      if (response.status < 200 || response.status >= 300) {
        throw httpStatusError(response.status, response.headers, descriptor.url);
      }
      if ((descriptor.rangeStart !== undefined || descriptor.rangeEnd !== undefined) && response.status !== 206) {
        throw new DownloadError('The server ignored a byte-range request for a media segment.', 'RANGE_UNSUPPORTED');
      }
      const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
      if (encoding && encoding !== 'identity') {
        throw new DownloadError('The media segment is compressed, which is not supported.', 'UNSUPPORTED_MEDIA');
      }
      const expected = contentLength(response.headers);
      let received = 0;
      for await (const raw of response.stream) {
        if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        await this.runtime.globalLimiter.consume(buffer.length, this.controller.signal);
        await this.writer.writeAt(this.currentOutputBytes, buffer);
        this.currentOutputBytes += buffer.length;
        received += buffer.length;
        this.speedMeter.add(buffer.length);
        this.emitProgress('downloading');
        if (Date.now() - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) void this.saveCheckpoint(false);
      }
      if (descriptor.rangeStart !== undefined && descriptor.rangeEnd !== undefined && expected !== null) {
        const rangeLength = descriptor.rangeEnd - descriptor.rangeStart + 1;
        if (received < rangeLength) throw new DownloadError('The media segment ended early.', 'NETWORK', { retryable: true });
      } else if (expected !== null && received < expected) {
        throw new DownloadError('The media segment ended early.', 'NETWORK', { retryable: true });
      }
    } finally {
      response?.close();
      release();
    }
  }

  private refreshSyntheticSegment(): void {
    if (!this.prepared) return;
    const segment = this.prepared.segments[0];
    if (segment) {
      segment.downloadedBytes = this.currentOutputBytes;
      segment.status = 'active';
    }
  }

  private async rollbackTo(offset: number): Promise<void> {
    this.currentOutputBytes = offset;
    if (!this.writer) return;
    await this.writer.truncate(offset).catch(() => undefined);
    if (this.state) {
      this.state.outputBytes = offset;
      if (this.prepared) this.prepared.downloadedBytes = offset;
      this.refreshSyntheticSegment();
    }
  }

  private async finalize(): Promise<EngineOutcome> {
    if (!this.prepared || !this.writer || !this.state) throw new DownloadError('Media download not prepared.', 'INTERNAL');
    const total = this.currentOutputBytes;
    await this.writer.flush();
    await this.writer.truncate(total);
    await this.writer.close();
    this.writer = null;
    this.prepared.totalBytes = total;
    this.state.totalBytes = total;
    this.state.outputBytes = total;
    this.state.nextIndex = this.state.plan.segments.length;
    this.prepared.mediaState = JSON.stringify(this.state);
    this.prepared.downloadedBytes = total;
    let checksumStatus: ChecksumStatus = 'none';
    if (this.config.checksum && this.config.checksumAlgorithm) {
      const actual = await hashFile(this.prepared.tempPath, this.config.checksumAlgorithm);
      if (actual.toLowerCase() !== this.config.checksum.trim().toLowerCase()) {
        throw new DownloadError('Checksum mismatch.', 'CHECKSUM_MISMATCH');
      }
      checksumStatus = 'verified';
    }
    this.emitProgress('finalizing');
    const finalPath = await resolveTargetPath(
      this.prepared.destinationDir,
      this.prepared.fileName,
      this.config.conflictPolicy,
      reservedPathsExcept(this.reservedSet(), this.prepared.targetPath)
    );
    const placed = await atomicPlace(
      this.prepared.tempPath,
      finalPath,
      this.config.conflictPolicy === 'overwrite',
      { sourceUrl: this.config.url, referrer: this.config.referrer }
    );
    this.prepared.targetPath = placed;
    await this.saveCheckpoint(true);
    return {
      status: 'completed',
      result: {
        fileName: path.basename(placed),
        targetPath: placed,
        finalUrl: this.prepared.finalUrl,
        totalBytes: total,
        downloadedBytes: total,
        checksumStatus,
        segments: [{ index: 0, startByte: 0, endByte: total > 0 ? total - 1 : null, downloadedBytes: total, status: 'complete' }],
        mimeType: this.prepared.mimeType,
        mediaState: this.prepared.mediaState
      }
    };
  }

  private async pausedOutcome(): Promise<EngineOutcome> {
    if (!this.prepared || !this.state) return { status: 'paused', checkpoint: null };
    await this.rollbackTo(this.state.outputBytes);
    this.prepared.mediaState = JSON.stringify(this.state);
    this.prepared.downloadedBytes = this.state.outputBytes;
    return {
      status: 'paused',
      checkpoint: {
        prepared: { ...this.prepared, segments: this.prepared.segments.map((segment) => ({ ...segment })) },
        status: 'paused',
        downloadedBytes: this.state.outputBytes,
        totalBytes: this.state.totalBytes,
        attempts: this.attempts,
        mediaState: this.prepared.mediaState
      }
    };
  }

  private parseResumeState(resume: ResumeState | undefined): MediaState | null {
    if (!resume?.mediaState) return null;
    try {
      const state = JSON.parse(resume.mediaState) as MediaState;
      if (!state || state.plan?.v !== 1 || !Array.isArray(state.plan.segments)) return null;
      if (typeof state.nextIndex !== 'number' || typeof state.outputBytes !== 'number') return null;
      return state;
    } catch {
      return null;
    }
  }

  private async cleanupTemp(): Promise<void> {
    await this.closeWriter();
    const temp = this.prepared?.tempPath ?? this.config.resume?.tempPath;
    if (temp) await fsp.rm(temp, { force: true }).catch(() => undefined);
  }

  private async closeWriter(): Promise<void> {
    if (!this.writer) return;
    const writer = this.writer;
    this.writer = null;
    await writer.close().catch(() => undefined);
  }

  private emitProgress(status: 'connecting' | 'downloading' | 'verifying' | 'finalizing'): void {
    if (!this.prepared) return;
    const now = Date.now();
    if (status === 'downloading' && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    const speed = status === 'downloading' ? this.speedMeter.speed() : 0;
    this.callbacks.onProgress({
      status,
      downloadedBytes: this.currentOutputBytes,
      totalBytes: null,
      speedBps: Math.round(speed),
      etaSeconds: null,
      segments: this.prepared.segments.map((segment) => ({ ...segment })),
      attempts: this.attempts
    });
  }

  private saveCheckpoint(force: boolean): Promise<void> {
    if (!this.prepared || !this.state) return this.checkpointChain;
    const now = Date.now();
    if (!force && now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return this.checkpointChain;
    this.lastCheckpointAt = now;
    this.prepared.mediaState = JSON.stringify(this.state);
    this.prepared.downloadedBytes = this.currentOutputBytes;
    const checkpoint: EngineCheckpoint = {
      prepared: { ...this.prepared, segments: this.prepared.segments.map((segment) => ({ ...segment })) },
      status: 'downloading',
      downloadedBytes: this.currentOutputBytes,
      totalBytes: this.state.totalBytes,
      attempts: this.attempts,
      mediaState: this.prepared.mediaState
    };
    this.checkpointChain = this.checkpointChain
      .then(() => this.callbacks.onCheckpoint(checkpoint))
      .catch((error) => this.log('warn', `Could not persist media progress: ${(error as Error).message}`));
    return this.checkpointChain;
  }

  private mimeForExtension(extension: string): string {
    if (extension === '.mp4') return 'video/mp4';
    if (extension === '.m4a') return 'audio/mp4';
    if (extension === '.webm') return 'video/webm';
    if (extension === '.weba') return 'audio/webm';
    if (extension === '.ts') return 'video/mp2t';
    return 'application/octet-stream';
  }

  private reservedSet(): Set<string> {
    return this.runtime.reservedTargetPaths ?? new Set<string>();
  }

  private async sleep(ms: number): Promise<void> {
    if (this.runtime.sleep) {
      await this.runtime.sleep(ms, this.controller.signal);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DownloadError('The download was stopped.', 'ABORTED'));
      };
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.runtime.logger(level, message, { downloadId: this.config.id });
    try {
      this.callbacks.onLog(level, message);
    } catch {
      // Ignore logging errors.
    }
  }
}
