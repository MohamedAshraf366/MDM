import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ChecksumAlgorithm } from '../shared/types';

export type HashName = 'sha256' | 'sha1' | 'md5';

export function normalizeAlgorithm(algorithm: string | null | undefined): HashName | null {
  if (algorithm === 'sha256' || algorithm === 'sha1' || algorithm === 'md5') return algorithm;
  return null;
}

export async function hashFile(
  filePath: string,
  algorithm: ChecksumAlgorithm,
  onProgress?: (hashedBytes: number) => void,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw new Error('Aborted');
  const hash = crypto.createHash(algorithm);
  let hashed = 0;
  const source = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of source) {
    if (signal?.aborted) {
      source.destroy();
      throw new Error('Aborted');
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    hashed += buffer.length;
    onProgress?.(hashed);
  }
  return hash.digest('hex');
}

export async function hashBuffer(buffer: Buffer, algorithm: ChecksumAlgorithm): Promise<string> {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a.trim().toLowerCase(), 'hex');
  const right = Buffer.from(b.trim().toLowerCase(), 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}
