import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashBuffer, hashFile, constantTimeEqualHex } from '../src/engine/checksum';
import { Semaphore, SpeedMeter, TokenBucket, backoffDelay } from '../src/engine/rate-limiter';
import { checkDiskSpace, SparseFileWriter, resolveTargetPath, uniquePathSync } from '../src/engine/fs-utils';
import {
  DownloadError,
  friendlyErrorMessage,
  isRetryableNetworkError,
  mapNetworkError
} from '../src/engine/errors';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-utils-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('checksums', () => {
  it('hashes buffers and files consistently', async () => {
    const directory = await tempDirectory();
    const data = Buffer.from('MDM integrity check');
    const file = path.join(directory, 'payload.bin');
    await fsp.writeFile(file, data);
    const expected = crypto.createHash('sha256').update(data).digest('hex');
    expect(await hashBuffer(data, 'sha256')).toBe(expected);
    expect(await hashFile(file, 'sha256')).toBe(expected);
    expect(constantTimeEqualHex(expected, expected.toUpperCase())).toBe(true);
    expect(constantTimeEqualHex(expected, '00')).toBe(false);
  });

  it('reports hashing progress', async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, 'large.bin');
    await fsp.writeFile(file, Buffer.alloc(2 * 1024 * 1024, 7));
    const progress: number[] = [];
    await hashFile(file, 'md5', (bytes) => progress.push(bytes));
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(2 * 1024 * 1024);
  });
});

describe('rate limiting primitives', () => {
  it('allows immediate consumption when unlimited', async () => {
    const bucket = new TokenBucket(0);
    await expect(bucket.consume(1024 * 1024)).resolves.toBeUndefined();
    expect(bucket.getRate()).toBe(0);
  });

  it('limits concurrent semaphore holders and drains the queue', async () => {
    const semaphore = new Semaphore(2);
    const releaseFirst = await semaphore.acquire();
    const releaseSecond = await semaphore.acquire();
    expect(semaphore.active).toBe(2);
    let thirdAcquired = false;
    const third = semaphore.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdAcquired).toBe(false);
    releaseFirst();
    const releaseThird = await third;
    expect(thirdAcquired).toBe(true);
    releaseSecond();
    releaseThird();
    expect(semaphore.active).toBe(0);
  });

  it('aborts queued semaphore acquisitions', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const pending = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    release();
  });

  it('applies limit changes without starving queued or active holders', async () => {
    const semaphore = new Semaphore(1);
    const releaseFirst = await semaphore.acquire();

    let secondAcquired = false;
    let releaseSecond: (() => void) | null = null;
    const second = semaphore.acquire().then((release) => {
      secondAcquired = true;
      releaseSecond = release;
    });

    // Raising the limit releases a queued waiter immediately.
    semaphore.setMax(2);
    await second;
    expect(secondAcquired).toBe(true);
    expect(semaphore.active).toBe(2);

    // Lowering below the active count must not revoke running holders; the
    // next acquisition waits until enough slots drain.
    semaphore.setMax(1);
    expect(semaphore.active).toBe(2);
    let thirdAcquired = false;
    let releaseThird: (() => void) | null = null;
    const third = semaphore.acquire().then((release) => {
      thirdAcquired = true;
      releaseThird = release;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdAcquired).toBe(false);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdAcquired).toBe(false);

    releaseSecond!();
    await third;
    expect(thirdAcquired).toBe(true);
    releaseThird!();
    expect(semaphore.active).toBe(0);
  });

  it('computes bounded exponential backoff', () => {
    expect(backoffDelay(1, 1000, 250)).toBe(250);
    expect(backoffDelay(1, 1000)).toBeGreaterThanOrEqual(700);
    expect(backoffDelay(1, 1000)).toBeLessThanOrEqual(1300);
    expect(backoffDelay(10, 1000)).toBeLessThanOrEqual(60_000);
  });

  it('tracks speed over a sampling window', async () => {
    const meter = new SpeedMeter(10_000);
    meter.add(1000);
    await new Promise((resolve) => setTimeout(resolve, 12));
    meter.add(1000);
    expect(meter.speed()).toBeGreaterThan(0);
    meter.reset();
    expect(meter.speed()).toBe(0);
  });
});

describe('network error mapping', () => {
  it('allows one retry for transient certificate-chain failures', () => {
    const chain = Object.assign(new Error('self signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN'
    });
    const chainMapped = mapNetworkError(chain);
    expect(chainMapped.code).toBe('TLS_CHAIN');
    expect(chainMapped.retryable).toBe(true);
    expect(isRetryableNetworkError(chainMapped)).toBe(true);
    expect(friendlyErrorMessage(chainMapped)).toContain('certificate chain');
  });

  it('keeps invalid leaf certificates non-retryable and distinct from transient TLS handshakes', () => {
    const certificate = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED'
    });
    const certificateMapped = mapNetworkError(certificate);
    expect(certificateMapped.code).toBe('TLS');
    expect(certificateMapped.retryable).toBe(false);
    expect(friendlyErrorMessage(certificateMapped)).toContain('server certificate');

    const handshake = Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' }
    );
    const handshakeMapped = mapNetworkError(handshake);
    expect(handshakeMapped.code).toBe('TLS_HANDSHAKE');
    expect(handshakeMapped.retryable).toBe(true);
    expect(isRetryableNetworkError(handshakeMapped)).toBe(true);
    expect(friendlyErrorMessage(handshakeMapped)).toContain('TLS handshake failed');
  });
});

describe('file system helpers', () => {
  it('writes sparse regions at absolute offsets', async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, 'sparse.bin');
    const writer = new SparseFileWriter(file);
    await writer.open(1024);
    await writer.writeAt(512, Buffer.from('tail'));
    await writer.flush();
    await writer.truncate(1024);
    await writer.close();
    const contents = await fsp.readFile(file);
    expect(contents).toHaveLength(1024);
    expect(contents.subarray(0, 512).every((byte) => byte === 0)).toBe(true);
    expect(contents.subarray(512, 516).toString()).toBe('tail');
  });

  it('reserves unique target paths and avoids case collisions', async () => {
    const directory = await tempDirectory();
    const existing = path.join(directory, 'report.txt');
    await fsp.writeFile(existing, 'first');
    const reserved = new Set<string>();
    const first = await resolveTargetPath(directory, 'report.txt', 'rename', reserved);
    expect(path.basename(first)).toBe('report (1).txt');
    reserved.add(first);
    const second = await resolveTargetPath(directory, 'report.txt', 'rename', reserved);
    expect(path.basename(second)).toBe('report (2).txt');
    expect(uniquePathSync(existing, new Set())).toBe(path.join(directory, 'report (1).txt'));
  });

  it('reports required and available disk space with an actionable message', async () => {
    const directory = await tempDirectory();
    const error = await checkDiskSpace(directory, 2 * 1024 ** 3, async () => 1024 ** 3).catch((reason) => reason);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.code).toBe('DISK_FULL');
    const message = friendlyErrorMessage(error);
    expect(message).toContain('Required 2.01 GB');
    expect(message).toContain('available 1.00 GB');
    expect(message).toContain('Choose another download folder or free up space, then retry.');
  });
});
